#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PORT=${1:-9080}
HOST=${2:-"0.0.0.0"}

echo "🚀 Iniciando Venolie TV IPTV API en http://$HOST:$PORT..."
exec python3 -m uvicorn main:app --host $HOST --port $PORT
