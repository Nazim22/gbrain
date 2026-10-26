#!/usr/bin/env python3
"""134-only connect controls. No database messages or cloud connections."""
import os
import pathlib
import signal
import socket
import sys
import time

ready = pathlib.Path(sys.argv[1])
sockets = []
created = []

def cleanup(*_):
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
    ready.write_text('134-only isolation controls ready\n')
    created.append(ready)
    while True:
        time.sleep(60)
finally:
    cleanup()
