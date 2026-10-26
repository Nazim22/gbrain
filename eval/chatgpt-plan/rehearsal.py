#!/usr/bin/env python3
"""134-only connect controls. No database messages or cloud connections."""
import os
import pathlib
import signal
import socket
import sys
import time
import json
import select
import socketserver
import threading
import urllib.request

ready = pathlib.Path(sys.argv[1])
sockets = []
created = []
servers = []

class LocalServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

class Forward(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection(('127.0.0.1', 1455), timeout=6) as target:
                peers = (self.request, target)
                deadline = time.monotonic() + 7
                while time.monotonic() < deadline:
                    readable, _, _ = select.select(peers, [], [], .1)
                    for source in readable:
                        data = source.recv(8192)
                        if not data:
                            return
                        (target if source is self.request else self.request).sendall(data)
        except OSError:
            pass  # A timeout is the expected evaluation-mode negative control.

class PositiveCallback(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(8192)
        self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK')

def start_server(server):
    servers.append(server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server

def callback_through_forward(port):
    # Local TCP forwarding exercises the same loopback reply direction as SSH -L;
    # it does not establish SSH authentication or contact an OAuth issuer.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{port}/auth/callback?state=local-rehearsal', timeout=4) as response:
        return response.status == 200, response.read(128)

def cleanup(*_):
    for server in servers:
        server.shutdown()
        server.server_close()
    for sock in sockets:
        sock.close()
    for path in reversed(created):
        path.unlink(missing_ok=True)
    raise SystemExit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)
try:
    for host in ('127.0.0.1', '::1'):
        for port in (8084, 5432, 18790, 11434, 18789):
            family = socket.AF_INET6 if ':' in host else socket.AF_INET
            control = socket.socket(family)
            control.settimeout(.3)
            try:
                control.connect((host, port))
                print(f'root positive existing {host}:{port}', flush=True)
            except OSError:
                sock = socket.socket(family)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind((host, port))
                sock.listen(64)
                sockets.append(sock)
                print(f'root positive stub {host}:{port}', flush=True)
            finally:
                control.close()
    target = pathlib.Path('/root/.gbrain/pg.env')
    if not target.exists():
        target.parent.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, b'S552 harmless filesystem-isolation fixture\n')
        os.close(fd)
        created.append(target)
    unix = socket.socket(socket.AF_UNIX)
    unix.settimeout(.3)
    try:
        unix.connect('/var/run/postgresql/.s.PGSQL.5432')
        print('root positive PostgreSQL Unix socket (connect only)', flush=True)
    finally:
        unix.close()
    forward = start_server(LocalServer(('127.0.0.1', 0), Forward))
    positive = start_server(LocalServer(('127.0.0.1', 1455), PositiveCallback))
    assert callback_through_forward(forward.server_address[1]) == (True, b'OK')
    print('root positive local TCP-forwarded callback OK (not an SSH-auth proof)', flush=True)
    positive.shutdown()
    positive.server_close()
    servers.remove(positive)
    ready.write_text('134-only isolation controls ready\n')
    created.append(ready)
    callback_ready = pathlib.Path(str(ready) + '.callback-ready')
    result = pathlib.Path(str(ready) + '.callback-result')
    created.extend([callback_ready, result])
    deadline = time.monotonic() + 30
    while not callback_ready.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError('callback listener readiness timeout')
        time.sleep(.05)
    try:
        status, body = callback_through_forward(forward.server_address[1])
        completed = status and body == b'Sign-in completed. Close this window.'
    except (OSError, TimeoutError):
        completed = False
    # Bounded metadata only; no real code, state, token, request body or auth call.
    result.write_text(json.dumps({'completed': completed}))
    while True:
        time.sleep(60)
finally:
    cleanup()
