import { Readable } from 'node:stream';
import type WebSocket from 'ws';
import type { MessageEvent } from 'ws';
import type {
  BareRequest,
  RouteCallback,
  SocketRouteCallback,
} from './BareServer.js';
import { BareError } from './BareServer.js';
import type Server from './BareServer.js';
import {
  flattenHeader,
  mapHeadersFromArray,
  rawHeaderNames,
} from './headerUtil.js';
import { remoteToURL, urlToRemote } from './remoteUtil.js';
import type { BareHeaders } from './requestUtil.js';
import { bareFetch, nullBodyStatus, webSocketFetch } from './requestUtil.js';
import { joinHeaders, splitHeaders } from './splitHeaderUtil.js';
import type { SocketClientToServer, SocketServerToClient } from './V3Types.js';

const forbiddenForwardHeaders: string[] = [
  'connection',
  'transfer-encoding',
  'host',
  'connection',
  'origin',
  'referer',
];

const forbiddenPassHeaders: string[] = [
  'vary',
  'connection',
  'transfer-encoding',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-request-headers',
  'access-control-request-method',
];

// common defaults
const defaultForwardHeaders: string[] = ['accept-encoding', 'accept-language'];

const defaultPassHeaders: string[] = [
  'content-encoding',
  'content-length',
  'last-modified',
];

// defaults if the client provides a cache key
const defaultCacheForwardHeaders: string[] = [
  'if-modified-since',
  'if-none-match',
  'cache-control',
];

const defaultCachePassHeaders: string[] = ['cache-control', 'etag'];

const cacheNotModified = 304;

function loadForwardedHeaders(
  forward: string[],
  target: BareHeaders,
  request: BareRequest
) {
  for (const header of forward) {
    if (request.headers.has(header)) {
      target[header] = request.headers.get(header)!;
    }
  }
}

const splitHeaderValue = /,\s*/g;

interface BareHeaderData {
  remote: URL;
  sendHeaders: BareHeaders;
  passHeaders: string[];
  passStatus: number[];
  forwardHeaders: string[];
}

function readHeaders(request: BareRequest): BareHeaderData {
  const sendHeaders: BareHeaders = Object.create(null);
  const passHeaders = [...defaultPassHeaders];
  const passStatus = [];
  const forwardHeaders = [...defaultForwardHeaders];

  // should be unique
  const cache = new URL(request.url).searchParams.has('cache');

  if (cache) {
    passHeaders.push(...defaultCachePassHeaders);
    passStatus.push(cacheNotModified);
    forwardHeaders.push(...defaultCacheForwardHeaders);
  }

  const headers = joinHeaders(request.headers);

  const xBareURL = headers.get('x-bare-url');

  if (xBareURL === null)
    throw new BareError(400, {
      code: 'MISSING_BARE_HEADER',
      id: `request.headers.x-bare-url`,
      message: `Header was not specified.`,
    });

  const remote = urlToRemote(new URL(xBareURL));

  const xBareHeaders = headers.get('x-bare-headers');

  if (xBareHeaders === null)
    throw new BareError(400, {
      code: 'MISSING_BARE_HEADER',
      id: `request.headers.x-bare-headers`,
      message: `Header was not specified.`,
    });

  try {
    const json = JSON.parse(xBareHeaders) as Record<string, string | string[]>;

    for (const header in json) {
      const value = json[header];

      if (typeof value === 'string') {
        sendHeaders[header] = value;
      } else if (Array.isArray(value)) {
        const array: string[] = [];

        for (const val of value) {
          if (typeof val !== 'string') {
            throw new BareError(400, {
              code: 'INVALID_BARE_HEADER',
              id: `bare.headers.${header}`,
              message: `Header was not a String.`,
            });
          }

          array.push(val);
        }

        sendHeaders[header] = array;
      } else {
        throw new BareError(400, {
          code: 'INVALID_BARE_HEADER',
          id: `bare.headers.${header}`,
          message: `Header was not a String.`,
        });
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BareError(400, {
        code: 'INVALID_BARE_HEADER',
        id: `request.headers.x-bare-headers`,
        message: `Header contained invalid JSON. (${error.message})`,
      });
    } else {
      throw error;
    }
  }

  if (headers.has('x-bare-pass-status')) {
    const parsed = headers.get('x-bare-pass-status')!.split(splitHeaderValue);

    for (const value of parsed) {
      const number = parseInt(value);

      if (isNaN(number)) {
        throw new BareError(400, {
          code: 'INVALID_BARE_HEADER',
          id: `request.headers.x-bare-pass-status`,
          message: `Array contained non-number value.`,
        });
      } else {
        passStatus.push(number);
      }
    }
  }

  if (headers.has('x-bare-pass-headers')) {
    const parsed = headers.get('x-bare-pass-headers')!.split(splitHeaderValue);

    for (let header of parsed) {
      header = header.toLowerCase();

      if (forbiddenPassHeaders.includes(header)) {
        throw new BareError(400, {
          code: 'FORBIDDEN_BARE_HEADER',
          id: `request.headers.x-bare-forward-headers`,
          message: `A forbidden header was passed.`,
        });
      } else {
        passHeaders.push(header);
      }
    }
  }

  if (headers.has('x-bare-forward-headers')) {
    const parsed = headers
      .get('x-bare-forward-headers')!
      .split(splitHeaderValue);

    for (let header of parsed) {
      header = header.toLowerCase();

      if (forbiddenForwardHeaders.includes(header)) {
        throw new BareError(400, {
          code: 'FORBIDDEN_BARE_HEADER',
          id: `request.headers.x-bare-forward-headers`,
          message: `A forbidden header was forwarded.`,
        });
      } else {
        forwardHeaders.push(header);
      }
    }
  }

  return {
    remote: remoteToURL(remote),
    sendHeaders,
    passHeaders,
    passStatus,
    forwardHeaders,
  };
}

const tunnelRequest: RouteCallback = async (request, res, options) => {
  const abort = new AbortController();

  request.native.on('close', () => {
    if (!request.native.complete) abort.abort();
  });

  res.on('close', () => {
    abort.abort();
  });

  const { remote, sendHeaders, passHeaders, passStatus, forwardHeaders } =
    readHeaders(request);

  loadForwardedHeaders(forwardHeaders, sendHeaders, request);

  const response = await bareFetch(
    request,
    abort.signal,
    sendHeaders,
    remote,
    options
  );

  const responseHeaders = new Headers();

  for (const header of passHeaders) {
    if (!(header in response.headers)) continue;
    responseHeaders.set(header, flattenHeader(response.headers[header]!));
  }

  const status = passStatus.includes(response.statusCode!)
    ? response.statusCode!
    : 200;

  if (status !== cacheNotModified) {
    responseHeaders.set('x-bare-status', response.statusCode!.toString());
    responseHeaders.set('x-bare-status-text', response.statusMessage!);
    responseHeaders.set(
      'x-bare-headers',
      JSON.stringify(
        mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {
          ...(<BareHeaders>response.headers),
        })
      )
    );
  }

  return new Response(
    nullBodyStatus.includes(status) ? undefined : Readable.toWeb(response),
    {
      status,
      headers: splitHeaders(responseHeaders),
    }
  );
};

function readSocket(socket: WebSocket): Promise<SocketClientToServer> {
  return new Promise((resolve, reject) => {
    const messageListener = (event: MessageEvent) => {
      cleanup();

      if (typeof event.data !== 'string')
        return reject(
          new TypeError('the first websocket message was not a text frame')
        );

      try {
        resolve(JSON.parse(event.data));
      } catch (err) {
        reject(err);
      }
    };

    const closeListener = () => {
      cleanup();
    };

    const cleanup = () => {
      socket.removeEventListener('message', messageListener);
      socket.removeEventListener('close', closeListener);
      clearTimeout(timeout);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out before metadata could be read'));
    }, 10e3);

    socket.addEventListener('message', messageListener);
    socket.addEventListener('close', closeListener);
  });
}

const tunnelSocket: SocketRouteCallback = async (
  request,
  socket,
  head,
  options
) =>
  options.wss.handleUpgrade(request.native, socket, head, async (client) => {
    let _remoteSocket: WebSocket | undefined;

    try {
      const connectPacket = await readSocket(client);

      if (connectPacket.type !== 'connect')
        throw new Error('Client did not send open packet.');

      loadForwardedHeaders(
        connectPacket.forwardHeaders,
        connectPacket.headers,
        request
      );

      const [remoteReq, remoteSocket] = await webSocketFetch(
        request,
        connectPacket.headers,
        new URL(connectPacket.remote),
        connectPacket.protocols,
        options
      );

      _remoteSocket = remoteSocket;

      const setCookieHeader = remoteReq.headers['set-cookie'];
      const setCookies =
        setCookieHeader !== undefined
          ? Array.isArray(setCookieHeader)
            ? setCookieHeader
            : [setCookieHeader]
          : [];

      client.send(
        JSON.stringify({
          type: 'open',
          protocol: remoteSocket.protocol,
          setCookies,
        } as SocketServerToClient),
        // use callback to wait for this message to buffer and finally send before doing any piping
        // otherwise the client will receive a random message from the remote before our open message
        () => {
          remoteSocket.addEventListener('message', (event) => {
            client.send(event.data);
          });

          client.addEventListener('message', (event) => {
            remoteSocket.send(event.data);
          });

          remoteSocket.addEventListener('close', () => {
            client.close();
          });

          client.addEventListener('close', () => {
            remoteSocket.close();
          });

          remoteSocket.addEventListener('error', (error) => {
            if (options.logErrors) {
              console.error('Remote socket error:', error);
            }

            client.close();
          });

          client.addEventListener('error', (error) => {
            if (options.logErrors) {
              console.error('Serving socket error:', error);
            }

            remoteSocket.close();
          });
        }
      );
    } catch (err) {
      if (options.logErrors) console.error(err);
      client.close();
      if (_remoteSocket) _remoteSocket.close();
    }
  });

export default function registerV3(server: Server) {
  server.routes.set('/v3/', tunnelRequest);
  server.socketRoutes.set('/v3/', tunnelSocket);
  server.versions.push('v3');
}
