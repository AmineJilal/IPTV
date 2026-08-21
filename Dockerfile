FROM python:3.10-slim

# Instalar dependencias del sistema, Node.js (v18) y utilidades
RUN apt-get update && apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Configurar el directorio de trabajo
WORKDIR /app

# Copiar todo el código al contenedor
COPY . /app

# Instalar dependencias de Node.js (Backend Principal)
RUN cd backend && npm install

# Instalar dependencias de Python para las 4 APIs
RUN pip install --no-cache-dir -r "api-españa/requirements.txt"
RUN pip install --no-cache-dir -r "Arabic API/requirements.txt"
RUN pip install --no-cache-dir -r "yacinetv-api/requirements.txt"
RUN pip install --no-cache-dir -r "API iberoamericana/requirements.txt"

# Dar permisos al script de inicio
RUN chmod +x start.sh

# Exponer el puerto del Backend Node.js
# Koyeb enrutará automáticamente el tráfico al puerto 3000
EXPOSE 3000

# Iniciar todos los servicios usando el script ligero
CMD ["./start.sh"]
