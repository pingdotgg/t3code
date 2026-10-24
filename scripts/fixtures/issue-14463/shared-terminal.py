#!/usr/bin/env python3
"""Deterministic real PTY fixture: --mode tui|normal|burst; q exits TUI."""
import argparse
import select
import termios
import tty
import os
import signal
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--mode', choices=['tui', 'normal', 'burst'], default='tui')
parser.add_argument('--label', default='Shared terminal')
args = parser.parse_args()


def normal():
    sys.stdout.write('\x1b[?1049l\x1b[0m\x1b[2J\x1b[H\x1b[?25h\x1b[?12l')
    for row in range(1, 61):
        print(f'ROW {row:03d} | ' + '0123456789' * 12, flush=True)
    sys.stdout.write('CURSOR> \x1b[?25h\x1b[?12l')
    sys.stdout.flush()
    for line in sys.stdin:
        if line.strip() == 'q':
            break
        sys.stdout.write('INPUT ' + line + 'CURSOR> ')
        sys.stdout.flush()


def tui():
    old = termios.tcgetattr(sys.stdin)
    pending = True
    def redraw(*_):
        nonlocal pending
        pending = True
    signal.signal(signal.SIGWINCH, redraw)
    try:
        tty.setraw(sys.stdin)
        sys.stdout.write('\x1b[?1049h\x1b[?12l')
        while True:
            if pending:
                pending = False
                cols, rows = os.get_terminal_size()
                out = '\x1b[38;2;255;255;255m\x1b[48;2;0;45;100m\x1b[2J\x1b[H'
                lines = [f'{args.label} {cols} columns x {rows} rows',
                         'Every border must be visible', 'Resize either client; q exits',
                         '0123456789' * 40]
                for row in range(rows):
                    edge = row == 0 or row == rows - 1
                    content = '-' * max(0, cols - 2) if edge else (
                        'BOTTOM EDGE' if row == rows - 2 else
                        lines[row - 1] if 1 <= row <= len(lines) else '')
                    content = content[:max(0, cols-2)].ljust(max(0, cols-2))
                    out += f'\x1b[{row+1};1H' + ('+' if edge else '|') + content + ('+' if edge else '|')
                out += f'\x1b[{min(6,rows-1)};{min(4,cols-1)}H\x1b[?25h'
                sys.stdout.write(out)
                sys.stdout.flush()
            if select.select([sys.stdin], [], [], 0.1)[0]:
                if os.read(sys.stdin.fileno(), 1) in (b'q', b'\x03'):
                    break
    finally:
        sys.stdout.write('\x1b[0m\x1b[?1049l\x1b[?25h')
        sys.stdout.flush()
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)


if args.mode == 'normal':
    normal()
elif args.mode == 'burst':
    for row in range(20000):
        print(f'BURST {row:05d} ' + '0123456789' * 20)
    sys.stdout.flush()
    tui()
else:
    tui()
