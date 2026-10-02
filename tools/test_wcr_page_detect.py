#!/usr/bin/env python3
"""Regression: grayed 1980s-90s completion reports must be detected; permit-only scans must not.

Uses the PDFs saved during the Alpine hand-check (wells-state/handcheck). DEH1991-LWELL-8477 was not
saved; it is the same duplicated-privacy-notice miss as DEH1986-LWELL-6053 and is covered by the redo.
"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_county_wcr as X

HAND = os.environ.get('WELLS_HANDCHECK', '/workspace/wells-state/handcheck')
# permit -> pdf in the hand-check dir. Report page is inside the file; permit applications are too.
MISSES = {
    'DEH1985-LWELL-7760': 'DEH1985-LWELL-7760.pdf',       # grayed so hard PSM 4 returns nothing
    'DEH1986-LWELL-6053': 'DEH1986-LWELL-6053.pdf',       # privacy notice duplicated, blocks OCR
    'DEH1987-LWELL-11880': 'DEH1987-LWELL-11880_0.pdf',   # DAILLERS / ORILLERS
    'DEH1992-LWELL-6180': 'DEH1992-LWELL-6180_0.pdf',     # ORILLERS REPORT
    'DEH1996-LWELL-6302': 'DEH1996-LWELL-6302_0.pdf',     # DAILLERS / (12) WELL LOG
    'DEH1996-LWELL-6364': 'DEH1996-LWELL-6364_0.pdf',     # WELI-COMPLETION-REPC
}
TRUE_NEG = {
    'DEH1979-LWELL-6103': 'DEH1979-LWELL-6103.pdf',
    'DEH1979-LWELL-6163': 'DEH1979-LWELL-6163.pdf',
    'DEH1996-LWELL-4738': 'DEH1996-LWELL-4738_0.pdf',     # permit papers + "no work has been done" letter
}

def pages_of(pdf):
    with tempfile.TemporaryDirectory() as t:
        return [pg['page'] for pg in X.read_pdf(pdf, t)]

def main():
    fail = 0
    # permit-condition wording must not count as a report
    for phrase in (
        'a Water Well Drillers Report must be submitted within 30 days',
        'NAME OF WELL DRILLER',
        'upon completion of work I will furnish a complete and accurate log of the well',
        'Report Reason(s) for Denial or Necessary Conditions Here',
    ):
        if X.layer_is_wcr(phrase):
            print('FAIL phrase counted as WCR:', phrase); fail += 1
        else:
            print('ok phrase', phrase[:60])
    for permit, fn in {**MISSES, **TRUE_NEG}.items():
        path = os.path.join(HAND, fn)
        expect = permit in MISSES
        if not os.path.exists(path):
            print('SKIP missing', path); fail += 1; continue
        got = pages_of(path)
        ok = bool(got) == expect
        print(('ok' if ok else 'FAIL'), permit, 'pages', got, 'expect_report', expect)
        if not ok: fail += 1
    if fail:
        print(f'{fail} failure(s)'); sys.exit(1)
    print('wcr page detect: ok')

if __name__ == '__main__':
    main()
