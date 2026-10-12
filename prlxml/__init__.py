"""payroll-xml: convert and check certified payroll XML (PRL 1.2)."""
PRL_NS = "http://www.transxml.net/schema/prl/1.2"
TXL_NS = "http://www.transxml.net/schema/txl/1.0"
MAIN_XSD = "PRL-GML20170101pxs.xsd"


def expand_globs(args):
    """Paths from the command line. Windows cmd hands *.xml over as it is typed, so expand it here."""
    import glob
    from pathlib import Path

    out = []
    for a in args:
        s = str(a)
        if not Path(s).exists() and any(c in s for c in "*?["):
            out += [Path(h) for h in sorted(glob.glob(s))] or [Path(s)]
        else:
            out.append(Path(s))
    seen, once = set(), []
    for x in out:  # the same file named twice (w1.xml w*.xml) is checked once
        k = str(x.resolve())
        if k not in seen:
            seen.add(k)
            once.append(x)
    return once
