#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PORT=${1:-8080}
HOST=${2:-"0.0.0.0"}

PYTHON_BIN="$DIR/../.venv/bin/python3"
if [ ! -f "$PYTHON_BIN" ]; then
    PYTHON_BIN="python3"
fi

echo "🚀 Iniciando API TDT España en http://$HOST:$PORT..."
exec "$PYTHON_BIN" -m uvicorn main:app --host $HOST --port $PORT
