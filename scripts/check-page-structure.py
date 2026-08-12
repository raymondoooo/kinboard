#!/usr/bin/env python3
"""Check that page structure is intact — nesting, not just tag balance.

A settings reorder once moved seven sections out of the page container and into
<head>. Every tag was still balanced, so a balance check passed and a visibly
broken page shipped in a release. Balance is not the property that matters:
*where* an element sits is.

Usage: check-page-structure.py public/*.html
"""
import sys, glob
from html.parser import HTMLParser

VOID = {'area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr'}

class Checker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.sections, self.errors = [], [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'details' and 'card' in (a.get('class') or ''):
            self.sections.append((
                a.get('data-sec') or '(unnamed)',
                [t for t, _ in self.stack],
                [c for _, c in self.stack],
                self.getpos()[0],
            ))
        if tag not in VOID:
            self.stack.append((tag, a.get('class') or a.get('id') or ''))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(f'stray </{tag}> at line {self.getpos()[0]}')
        elif self.stack[-1][0] != tag:
            self.errors.append(
                f'</{tag}> at line {self.getpos()[0]} closes <{self.stack[-1][0]}>')
        else:
            self.stack.pop()


def check(path):
    c = Checker()
    c.feed(open(path).read())
    problems = list(c.errors)
    problems += [f'unclosed <{t}> at EOF' for t, _ in c.stack]
    for slug, ancestors, classes, line in c.sections:
        if 'head' in ancestors:
            problems.append(f'section "{slug}" (line {line}) is inside <head>')
        elif 'body' not in ancestors:
            problems.append(f'section "{slug}" (line {line}) is outside <body>')
        elif 'wrap' not in classes:
            problems.append(f'section "{slug}" (line {line}) is outside the page container')
    return problems, len(c.sections)


def main(argv):
    paths = [p for arg in (argv or ['public/*.html']) for p in sorted(glob.glob(arg))]
    failed = False
    for path in paths:
        problems, n = check(path)
        if problems:
            failed = True
            print(f'FAIL {path}')
            for p in problems:
                print(f'  {p}')
        else:
            print(f'  ok   {path} ({n} section(s))')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
