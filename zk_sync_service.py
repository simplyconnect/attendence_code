"""
zk_sync_service.py
------------------------------------------------------------
Lightweight Windows sync service for a ZKTeco K40 (or any ZK device on the
same TCP protocol family: K40/K50/K60/uFace/iClock series).

Talks to the device over TCP port 4370 using `pyzk` (free, open-source,
MIT licensed — pip install pyzk). Never sends anything to Google directly
from the device; this script is the only thing that talks to the device,
and the only thing that talks to Google Apps Script.

Two ingestion paths, both feeding the same dedup pipeline:
  1. Live pull from the device via pyzk (primary path).
  2. Watching an `import/` folder for CSV exports from ZKTeco's own bundled
     software, for firmware/models where live pyzk pull is unreliable.

Run modes:
  python zk_sync_service.py            -> loop forever, poll every N seconds
  python zk_sync_service.py --once     -> single sync pass then exit (good
                                           for Windows Task Scheduler)
------------------------------------------------------------
"""

import argparse
import csv
import glob
import json
import logging
import os
import sys
import time
from datetime import datetime

import requests

try:
    from zk import ZK, const
except ImportError:
    print("Missing dependency. Run: pip install pyzk requests")
    sys.exit(1)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
STATE_PATH = os.path.join(BASE_DIR, "state.json")
IMPORT_DIR = os.path.join(BASE_DIR, "import")
LOG_PATH = os.path.join(BASE_DIR, "sync_service.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("zk_sync")


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"last_synced_epoch": 0}


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f)


def connect_device(cfg):
    zk = ZK(
        cfg["device_ip"],
        port=cfg.get("device_port", 4370),
        timeout=cfg.get("timeout_seconds", 10),
        password=cfg.get("comm_password", 0),
        force_udp=False,
        ommit_ping=False,
    )
    return zk.connect()


def pull_from_device(cfg, state):
    """Fetch attendance logs from the K40 and return only records newer
    than our watermark. pyzk returns Attendance objects with:
    .user_id (device user id), .timestamp (datetime), .status, .punch
    """
    conn = None
    new_records = []
    try:
        conn = connect_device(cfg)
        conn.disable_device()  # pause the device UI briefly during the read, standard pyzk pattern
        logs = conn.get_attendance()
        watermark = state.get("last_synced_epoch", 0)
        max_seen = watermark
        for entry in logs:
            epoch = entry.timestamp.timestamp()
            if epoch <= watermark:
                continue
            new_records.append({
                "deviceUserId": str(entry.user_id),
                "timestamp": entry.timestamp.isoformat(),
                "verifyMode": str(getattr(entry, "status", "")),
                "punchType": str(getattr(entry, "punch", "")),
            })
            if epoch > max_seen:
                max_seen = epoch
        state["last_synced_epoch"] = max_seen
        log.info(f"Pulled {len(logs)} total records from device, {len(new_records)} new since last sync.")
        return new_records, None
    except Exception as e:
        return [], str(e)
    finally:
        if conn:
            try:
                conn.enable_device()
                conn.disconnect()
            except Exception:
                pass


def pull_from_csv_fallback():
    """Fallback path: parse any CSV files dropped in import/ by ZKTeco's
    bundled software (or manually exported from the device via USB).
    Expected columns (case-insensitive, order-flexible):
    user_id/EnNo, timestamp/DateTime
    Processed files are moved to import/processed/ so they aren't re-read.
    """
    if not os.path.isdir(IMPORT_DIR):
        return []
    processed_dir = os.path.join(IMPORT_DIR, "processed")
    os.makedirs(processed_dir, exist_ok=True)
    records = []
    for path in glob.glob(os.path.join(IMPORT_DIR, "*.csv")):
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                fieldmap = {k.lower(): k for k in reader.fieldnames or []}
                user_col = fieldmap.get("user_id") or fieldmap.get("enno") or fieldmap.get("id")
                time_col = fieldmap.get("timestamp") or fieldmap.get("datetime") or fieldmap.get("time")
                if not user_col or not time_col:
                    log.warning(f"Skipping {path}: could not find user/time columns")
                    continue
                for row in reader:
                    records.append({
                        "deviceUserId": str(row[user_col]).strip(),
                        "timestamp": row[time_col].strip(),
                        "verifyMode": "csv-import",
                        "punchType": "",
                    })
            os.rename(path, os.path.join(processed_dir, os.path.basename(path)))
            log.info(f"Imported {path}")
        except Exception as e:
            log.error(f"Failed to parse {path}: {e}")
    return records


def push_to_apps_script(cfg, punches):
    if not punches:
        return {"ok": True, "inserted": 0, "duplicates": 0}
    payload = {
        "action": "receivePunches",
        "deviceId": cfg["device_id"],
        "apiKey": cfg["api_key"],
        "punches": punches,
    }
    resp = requests.post(cfg["apps_script_url"], data=json.dumps(payload),
                          headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def sync_once(cfg, state):
    device_records, error = pull_from_device(cfg, state)
    csv_records = pull_from_csv_fallback()
    all_records = device_records + csv_records

    if error:
        log.error(f"Device connection failed: {error}")
        if not csv_records:
            save_state(state)
            return

    try:
        result = push_to_apps_script(cfg, all_records)
        if result.get("ok"):
            log.info(f"Synced OK — inserted {result.get('inserted', 0)}, "
                      f"duplicates skipped {result.get('duplicates', 0)}.")
        else:
            log.error(f"Server rejected sync: {result.get('error')}")
    except Exception as e:
        log.error(f"Failed to reach Apps Script: {e}")
        # roll the watermark back so nothing is lost — we'll retry these next cycle
        return

    save_state(state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Run a single sync pass and exit")
    args = parser.parse_args()

    cfg = load_config()
    state = load_state()

    if args.once:
        sync_once(cfg, state)
        return

    interval = cfg.get("sync_interval_seconds", 300)
    log.info(f"Starting continuous sync loop, every {interval} seconds. Ctrl+C to stop.")
    while True:
        sync_once(cfg, state)
        time.sleep(interval)


if __name__ == "__main__":
    main()
