"""
browser_scan.py - Standalone scanner that reads recent URLs from every
common browser's history database on Windows. Outputs a single JSON array
to stdout that you can paste into Loz's World's Situations panel.

Usage (PowerShell or cmd):
    python tools\\browser_scan.py > recent.json
    type recent.json   (to view)
    # then paste recent.json into the Situations panel's import box.

Or on Linux/macOS:
    python3 tools/browser_scan.py > recent.json

Why a standalone script: browsers lock their History DB while running. We
copy the file to a temp path first, then read - avoids "database is locked"
errors. Pure stdlib (sqlite3 ships with Python). No npm. No native build.
"""
from __future__ import annotations
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

# How many days back to scan, and how many records max.
DAYS = 14
LIMIT_PER_BROWSER = 200

# Browsers we know about, with their History-DB locations on Windows.
# All Chromium variants share the same schema.
WINDOWS_PROFILES = {
    'Chrome':  Path(os.environ.get('LOCALAPPDATA', '')) / 'Google'   / 'Chrome'         / 'User Data' / 'Default' / 'History',
    'Edge':    Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft'/ 'Edge'           / 'User Data' / 'Default' / 'History',
    'Brave':   Path(os.environ.get('LOCALAPPDATA', '')) / 'BraveSoftware' / 'Brave-Browser' / 'User Data' / 'Default' / 'History',
    'Vivaldi': Path(os.environ.get('LOCALAPPDATA', '')) / 'Vivaldi'  / 'User Data' / 'Default' / 'History',
    'Opera':   Path(os.environ.get('APPDATA',     '')) / 'Opera Software' / 'Opera Stable' / 'History',
    'OperaGX': Path(os.environ.get('APPDATA',     '')) / 'Opera Software' / 'Opera GX Stable' / 'History',
}

# Linux/macOS Chromium fallbacks.
HOME = Path.home()
LINUX_PROFILES = {
    'Chrome':  HOME / '.config' / 'google-chrome' / 'Default' / 'History',
    'Chromium':HOME / '.config' / 'chromium'      / 'Default' / 'History',
    'Brave':   HOME / '.config' / 'BraveSoftware' / 'Brave-Browser' / 'Default' / 'History',
}
MAC_PROFILES = {
    'Chrome':  HOME / 'Library' / 'Application Support' / 'Google' / 'Chrome'    / 'Default' / 'History',
    'Edge':    HOME / 'Library' / 'Application Support' / 'Microsoft Edge'        / 'Default' / 'History',
    'Brave':   HOME / 'Library' / 'Application Support' / 'BraveSoftware' / 'Brave-Browser' / 'Default' / 'History',
}


def chromium_profiles() -> dict[str, Path]:
    if sys.platform.startswith('win'):    return WINDOWS_PROFILES
    if sys.platform == 'darwin':          return MAC_PROFILES
    return LINUX_PROFILES


def chrome_time_to_unix_ms(chrome_us: int) -> int:
    """Chromium 'last_visit_time' is microseconds since 1601-01-01 UTC."""
    if not chrome_us: return 0
    return int(chrome_us / 1000 - 11644473600000)


def scan_chromium(browser: str, db_path: Path) -> list[dict]:
    if not db_path.exists(): return []
    # Copy to temp so a running browser's lock doesn't block us.
    with tempfile.NamedTemporaryFile(delete=False, suffix='.sqlite') as tmp:
        tmp_path = Path(tmp.name)
    try:
        shutil.copy2(db_path, tmp_path)
    except Exception as e:
        return [{'browser': browser, 'error': f'copy failed: {e}'}]
    try:
        cutoff_us = (int(time.time() * 1000) + 11644473600000) * 1000 - DAYS * 86400 * 1_000_000
        with sqlite3.connect(f'file:{tmp_path}?mode=ro', uri=True) as conn:
            cur = conn.execute(
                "SELECT url, title, last_visit_time, visit_count "
                "FROM urls WHERE last_visit_time > ? "
                "ORDER BY last_visit_time DESC LIMIT ?",
                (cutoff_us, LIMIT_PER_BROWSER)
            )
            return [
                {
                    'browser': browser,
                    'url': r[0],
                    'title': r[1] or '',
                    'lastVisit': chrome_time_to_unix_ms(r[2]),
                    'visits': r[3],
                }
                for r in cur.fetchall()
            ]
    except sqlite3.DatabaseError as e:
        return [{'browser': browser, 'error': f'sqlite: {e}'}]
    finally:
        try: tmp_path.unlink()
        except Exception: pass


def firefox_profiles() -> list[tuple[str, Path]]:
    """Return [(profile_name, places.sqlite_path), ...]."""
    out = []
    if sys.platform.startswith('win'):
        roots = [Path(os.environ.get('APPDATA', '')) / 'Mozilla' / 'Firefox' / 'Profiles']
    elif sys.platform == 'darwin':
        roots = [HOME / 'Library' / 'Application Support' / 'Firefox' / 'Profiles']
    else:
        roots = [HOME / '.mozilla' / 'firefox']
    for root in roots:
        if not root.exists(): continue
        for prof in root.iterdir():
            places = prof / 'places.sqlite'
            if places.exists(): out.append((prof.name, places))
    return out


def scan_firefox() -> list[dict]:
    out = []
    for name, db_path in firefox_profiles():
        with tempfile.NamedTemporaryFile(delete=False, suffix='.sqlite') as tmp:
            tmp_path = Path(tmp.name)
        try:
            shutil.copy2(db_path, tmp_path)
        except Exception as e:
            out.append({'browser': f'Firefox/{name}', 'error': f'copy failed: {e}'})
            continue
        try:
            cutoff_us = int(time.time() * 1_000_000) - DAYS * 86400 * 1_000_000
            with sqlite3.connect(f'file:{tmp_path}?mode=ro', uri=True) as conn:
                cur = conn.execute(
                    "SELECT url, title, last_visit_date, visit_count "
                    "FROM moz_places WHERE last_visit_date > ? "
                    "ORDER BY last_visit_date DESC LIMIT ?",
                    (cutoff_us, LIMIT_PER_BROWSER)
                )
                for r in cur.fetchall():
                    out.append({
                        'browser': f'Firefox/{name}',
                        'url': r[0],
                        'title': r[1] or '',
                        'lastVisit': int((r[2] or 0) / 1000),  # us -> ms
                        'visits': r[3],
                    })
        except sqlite3.DatabaseError as e:
            out.append({'browser': f'Firefox/{name}', 'error': f'sqlite: {e}'})
        finally:
            try: tmp_path.unlink()
            except Exception: pass
    return out


def main() -> None:
    results = []
    for name, path in chromium_profiles().items():
        results.extend(scan_chromium(name, path))
    results.extend(scan_firefox())
    results.sort(key=lambda r: r.get('lastVisit', 0), reverse=True)
    print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
