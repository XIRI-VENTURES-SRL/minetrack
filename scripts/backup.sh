#!/bin/sh
# Online backup of the Xiri Track SQLite database. Safe while Minetrack keeps running.
#
# Runs entirely inside the container (as the same user that owns the database), so the
# backups end up in data/backups/ on the host without any permission changes.
# Copy data/backups/ to another machine or storage provider as well, a backup on the
# same disk does not protect against losing that disk.
#
# Usage (from the repository directory, e.g. /opt/xiri-track):
#   scripts/backup.sh
# Cron example, daily at 03:17:
#   17 3 * * * cd /opt/xiri-track && scripts/backup.sh >> backups.log 2>&1

set -eu

cd "$(dirname "$0")/.."

KEEP="${KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# stdin comes from /dev/null: docker compose exec keeps stdin attached even with -T and would
# otherwise swallow the caller's remaining input (e.g. a script piped over ssh or a while-read loop)
docker compose exec -T minetrack sh -eu -c "
  mkdir -p /data/backups
  sqlite3 /data/database.sql \".backup '/data/backups/database-$STAMP.sql'\"
  sqlite3 '/data/backups/database-$STAMP.sql' 'PRAGMA integrity_check' | grep -qx ok
  gzip '/data/backups/database-$STAMP.sql'
  ls -1t /data/backups/database-*.sql.gz | tail -n +$((KEEP + 1)) | xargs -r rm --
" < /dev/null

echo "Backup written to data/backups/database-$STAMP.sql.gz"
