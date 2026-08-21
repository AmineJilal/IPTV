#!/bin/bash

# Iniciar las APIs de Python en segundo plano (cada una consume un pequeño % de CPU)
echo "🚀 Iniciando API Iberoamericana..."
cd "API iberoamericana" && python3 -m uvicorn main:app --host 0.0.0.0 --port 8090 &
cd ..

echo "🚀 Iniciando API Arabic..."
cd "Arabic API" && python3 -m uvicorn main:app --host 0.0.0.0 --port 9080 &
cd ..

echo "🚀 Iniciando API España..."
cd "api-españa" && python3 -m uvicorn main:app --host 0.0.0.0 --port 8080 &
cd ..

echo "🚀 Iniciando API Yacine..."
cd "yacinetv-api" && python3 -m uvicorn app:app --host 0.0.0.0 --port 8000 &
cd ..

# Iniciar el backend principal de Node.js en primer plano
# (Para que Koyeb detecte si se cae el principal y mantenga vivo el contenedor)
echo "🚀 Iniciando Node.js Backend..."
cd backend && npm start
