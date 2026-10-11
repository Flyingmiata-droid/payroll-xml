"""Download published schemas into ./schemas (not redistributed here).

    python -m prlxml.fetch_schemas        the AASHTO Payroll XML schema kit, into schemas/
    python -m prlxml.fetch_schemas ny     the New York DOL certified payroll schema, into schemas/nydol/
"""
import io
import sys
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

ZIP_URL = "https://xml.aashtowareproject.org/resourcekit/downloads/schemas.zip"
NY_URL = "https://dol.ny.gov/nydolcertpayrollxsd"


def _get(url):
    # dol.ny.gov refuses the default Python user agent
    return urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0 (payroll-xml)"}), timeout=60).read()


def fetch_ny(dest: str = "schemas/nydol") -> int:
    out = Path(dest)
    out.mkdir(parents=True, exist_ok=True)
    print(f"downloading {NY_URL}")
    with zipfile.ZipFile(io.BytesIO(_get(NY_URL))) as z:
        xsds = [n for n in z.namelist() if n.lower().endswith(".xsd")]
        if len(xsds) != 1:
            print(f"expected one .xsd in the zip, found {xsds}", file=sys.stderr)
            return 1
        # the state names it "NYDOL_CertPayroll UPDATED.xsd"; save it under the name its sample points at
        (out / "NYDOL_CertPayroll.xsd").write_bytes(z.read(xsds[0]))
    print(f"wrote {out / 'NYDOL_CertPayroll.xsd'} (from {xsds[0]})")
    return 0


def main(dest: str = "schemas") -> int:
    if dest == "ny":
        return fetch_ny()
    out = Path(dest)
    out.mkdir(parents=True, exist_ok=True)
    print(f"downloading {ZIP_URL}")
    data = _get(ZIP_URL)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()
        # the zip holds a top folder named schemas/; strip it
        for n in names:
            if n.endswith("/"):
                continue
            rel = n.split("/", 1)[1] if n.startswith("schemas/") else n
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(n))
    print(f"wrote {len(names)} entries under {out}/")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
