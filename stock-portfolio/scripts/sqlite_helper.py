import json
import sqlite3
import sys


def connect(db_path):
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS holdings (
          code TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          shares REAL NOT NULL CHECK (shares > 0),
          cost REAL NOT NULL CHECK (cost >= 0),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    return connection


def list_holdings(connection):
    rows = connection.execute(
        "SELECT code, name, shares, cost FROM holdings ORDER BY code"
    ).fetchall()
    return {"holdings": [dict(row) for row in rows]}


def upsert_holding(connection, payload):
    connection.execute(
        """
        INSERT INTO holdings (code, name, shares, cost, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          shares = excluded.shares,
          cost = excluded.cost,
          updated_at = CURRENT_TIMESTAMP
        """,
        (payload["code"], payload.get("name", ""), payload["shares"], payload["cost"]),
    )
    connection.commit()
    row = connection.execute(
        "SELECT code, name, shares, cost FROM holdings WHERE code = ?",
        (payload["code"],),
    ).fetchone()
    return {"holding": dict(row)}


def delete_holding(connection, payload):
    connection.execute("DELETE FROM holdings WHERE code = ?", (payload["code"],))
    connection.commit()
    return {"ok": True}


def clear_holdings(connection):
    connection.execute("DELETE FROM holdings")
    connection.commit()
    return {"ok": True}


def main():
    db_path, action, raw_payload = sys.argv[1], sys.argv[2], sys.argv[3]
    payload = json.loads(raw_payload)

    with connect(db_path) as connection:
        if action == "list":
            result = list_holdings(connection)
        elif action == "upsert":
            result = upsert_holding(connection, payload)
        elif action == "delete":
            result = delete_holding(connection, payload)
        elif action == "clear":
            result = clear_holdings(connection)
        else:
            raise SystemExit(f"Unknown action: {action}")

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
