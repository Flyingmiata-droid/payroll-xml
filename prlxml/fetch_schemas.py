"""Download the published Payroll XML schema kit into ./schemas (not redistributed here)."""
import io
import sys
import zipfile
from pathlib import Path
from urllib.request import urlopen

ZIP_URL = "https://xml.aashtowareproject.org/resourcekit/downloads/schemas.zip"


def main(dest: str = "schemas") -> int:
    out = Path(dest)
    out.mkdir(parents=True, exist_ok=True)
    print(f"downloading {ZIP_URL}")
    data = urlopen(ZIP_URL, timeout=60).read()
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
