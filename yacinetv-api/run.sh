#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PORT=${1:-8000}
HOST=${2:-"0.0.0.0"}

echo "🚀 Iniciando YacineTV API en http://$HOST:$PORT..."
exec python3 -m uvicorn app:app --host $HOST --port $PORT