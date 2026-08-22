#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

echo "🚀 Iniciando API Iberoamericana..."
(cd "$DIR/API iberoamericana" && python3 -m uvicorn main:app --host 0.0.0.0 --port 8090) &

echo "🚀 Iniciando API Arabic..."
(cd "$DIR/Arabic API" && python3 -m uvicorn main:app --host 0.0.0.0 --port 9080) &

echo "🚀 Iniciando API España..."
(cd "$DIR/api-españa" && python3 -m uvicorn main:app --host 0.0.0.0 --port 8080) &

echo "🚀 Iniciando API Yacine..."
(cd "$DIR/yacinetv-api" && python3 -m uvicorn app:app --host 0.0.0.0 --port 8000) &

echo "🚀 Iniciando Node.js Backend..."
cd "$DIR/backend" && npm start
