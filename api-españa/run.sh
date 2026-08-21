#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PORT=${1:-8080}
HOST=${2:-"0.0.0.0"}

echo "🚀 Iniciando API TDT España en http://$HOST:$PORT..."
exec python3 -m uvicorn main:app --host $HOST --port $PORT
