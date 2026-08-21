#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PORT=${1:-8090}
HOST=${2:-"0.0.0.0"}

echo "🚀 Iniciando API Futbol Libre Ibero en http://$HOST:$PORT..."
exec python3 -m uvicorn main:app --host $HOST --port $PORT
