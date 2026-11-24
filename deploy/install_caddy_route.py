"""Install the reviewed MCP route in an existing, file-bind-mounted Caddy site.

Run on the proxy host, after verifying the backend is healthy. Pass --apply to
write/reload; by default only checks scope, live config and candidate syntax.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def docker(container, *arguments, data=None):
    p = subprocess.run(['docker', 'exec', *(['-i'] if data is not None else []), container, *arguments],
                       input=data, capture_output=True, timeout=30)
    if p.returncode:
        # Logs and the full config can include credentials. Do not print them.
        raise RuntimeError(f'command failed in proxy container: {arguments[0]} {arguments[1]}')
    return p.stdout


def install(args):
    path = Path(args.config).resolve(strict=True)
    snippet = Path(__file__).with_name('caddy-route.caddy').read_bytes().replace(b'\r\n', b'\n')
    config = args.container_config
    c = args.container
    validate = lambda b: docker(c, 'caddy', 'validate', '--config', '-', '--adapter', 'caddyfile', data=b)
    adapt = lambda target: json.loads(docker(c, 'caddy', 'adapt', '--config', target, '--adapter', 'caddyfile'))
    live = lambda: json.loads(docker(c, 'wget', '-qO-', 'http://127.0.0.1:2019/config/'))
    reload_site = lambda: docker(c, 'caddy', 'reload', '--config', config, '--adapter', 'caddyfile')
    with path.open('r+b' if args.apply else 'rb') as f:
        fcntl.flock(f, fcntl.LOCK_EX if args.apply else fcntl.LOCK_SH)
        original = f.read()
        if hashlib.sha256(original).hexdigest() != args.expected_sha256:
            raise ValueError('config changed since inspection; refusing to overwrite')
        if docker(c, 'cat', config) != original or adapt(config) != live():
            raise ValueError('mounted file and active proxy config differ; nothing was written')
        site = b'https://api.chiyotobi.party {\n'
        marker = b'\thandle {\n\t\treverse_proxy qiandaiapi-app:8080\n\t}'
        if original.count(site) != 1 or b'/mcp/*' in original:
            raise ValueError('ambiguous host block or existing /mcp route')
        start = original.index(site) + len(site)
        end = original.index(b'\n}', start)
        block = original[start:end]
        if block.count(marker) != 1:
            raise ValueError('expected fallback missing in target TLS site')
        candidate = original[:start] + block.replace(marker, snippet + b'\n' + marker) + original[end:]
        validate(candidate)
        if not args.apply:
            print('Candidate syntax and existing live configuration verified; no changes.')
            return
        # Existing Caddy bind-mount points at this inode: never replace it via rename.
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        fd, backup = tempfile.mkstemp(prefix=f'{path.name}.pre-mcp-{stamp}-', dir=path.parent)
        with os.fdopen(fd, 'wb') as b:
            b.write(original); b.flush(); os.fsync(b.fileno())
        if Path(backup).read_bytes() != original:
            raise RuntimeError('backup verification failed')
        print(f'Backup: {backup}', flush=True)
        def write(data):
            f.seek(0); f.write(data); f.truncate(); f.flush(); os.fsync(f.fileno())
        f.seek(0)
        if f.read() != original or not os.path.samestat(os.fstat(f.fileno()), path.stat()):
            raise ValueError('another operator changed the site; refusing to proceed')
        try:
            write(candidate)
            if docker(c, 'cat', config) != candidate:
                raise RuntimeError('container did not see candidate bytes')
            docker(c, 'caddy', 'validate', '--config', config, '--adapter', 'caddyfile')
            reload_site()
            if adapt(config) != live():
                raise RuntimeError('reloaded config does not match site file')
        except BaseException:
            write(original)
            docker(c, 'caddy', 'validate', '--config', config, '--adapter', 'caddyfile')
            reload_site()
            print('Restored original configuration and gracefully reloaded it.', flush=True)
            raise
        print('Route installed with a graceful reload; no containers restarted.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='host path to the existing Caddyfile')
    parser.add_argument('--container', required=True)
    parser.add_argument('--container-config', default='/etc/caddy/Caddyfile')
    parser.add_argument('--expected-sha256', required=True, help='operator-verified pre-change digest')
    parser.add_argument('--apply', action='store_true')
    install(parser.parse_args())
