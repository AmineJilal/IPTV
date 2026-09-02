#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# FIX #10: Matar procesos anteriores para evitar procesos zombis duplicados
echo "🧹 Limpiando procesos anteriores..."
pkill -f "uvicorn" 2>/dev/null || true
pkill -f "tor" 2>/dev/null || true
sleep 1

echo "🚀 Iniciando red Tor en background (SOCKS5)..."
tor > /dev/null 2>&1 &
sleep 3

echo "🚀 Iniciando API Iberoamericana..."
(cd "$DIR/API iberoamericana" && python3 -m uvicorn main:app --host 0.0.0.0 --port 8090) &

echo "🚀 Iniciando API Arabic..."
(cd "$DIR/Arabic API" && python3 -m uvicorn main:app --host 0.0.0.0 --port 9080) &

echo "🚀 Iniciando API España..."
(cd "$DIR/api-españa" && python3 -m uvicorn main:app --host 0.0.0.0 --port 8080) &

echo "🚀 Iniciando API Yacine..."
(cd "$DIR/yacinetv-api" && python3 -m uvicorn app:app --host 0.0.0.0 --port 8000) &

echo "🚀 Iniciando API Movistar..."
(cd "$DIR/api-movistar" && python3 -m uvicorn main:app --host 0.0.0.0 --port 8070) &

echo "🚀 Iniciando Node.js Backend..."
(cd "$DIR/backend" && node server.js)
