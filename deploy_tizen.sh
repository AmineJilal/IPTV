#!/bin/bash

# Script de despliegue para Tizen (Kovalsky TV)
# Este script compila y despliega la app en la TV automáticamente

set -e  # Exit on error

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================
# CONFIGURACIÓN
# ============================================

PROJECT_DIR="/home/amin/Escritorio/IPTV LOCAL"
APP_PROJECT="$PROJECT_DIR/app_iptv"
BUILD_DIR="$APP_PROJECT/build/web"
TV_ID="TU43U7025FKXXC"
APP_ID="oJ8S9K1v2L.KovalskyTV"

# Detectar instalación de Tizen
TIZEN_BIN=""
for path in "/home/amin/tizen-studio/tools/ide/bin/tizen" \
            "/opt/tizen-studio/tools/ide/bin/tizen" \
            "$HOME/tizen-studio/tools/ide/bin/tizen" \
            "$(which tizen)" \
            "/usr/local/bin/tizen"; do
    if [ -f "$path" ] 2>/dev/null; then
        TIZEN_BIN="$path"
        break
    fi
done

# WGT se genera en la carpeta de Tizen Studio
WGT_OUTPUT="$(dirname $TIZEN_BIN)/build/tizen"

if [ -z "$TIZEN_BIN" ]; then
    echo -e "${RED}❌ Error: Tizen CLI no encontrado.${NC}"
    echo "Por favor proporciona la ruta de instalación de Tizen Studio:"
    read -p "Ruta (ej: /home/amin/tizen-studio): " TIZEN_PATH
    if [ ! -d "$TIZEN_PATH" ]; then
        echo -e "${RED}❌ Ruta inválida: $TIZEN_PATH${NC}"
        exit 1
    fi
    TIZEN_BIN="$TIZEN_PATH/tools/ide/bin/tizen"
fi

if [ ! -f "$TIZEN_BIN" ]; then
    echo -e "${RED}❌ Tizen CLI no existe en: $TIZEN_BIN${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Tizen CLI encontrado: $TIZEN_BIN${NC}"

# ============================================
# PASO 1: Conectar a la TV
# ============================================
echo -e "\n${YELLOW}[1/5] Conectando a la TV...${NC}"

SDB_BIN="$(dirname $TIZEN_BIN)/../../../tools/sdb"
if [ ! -f "$SDB_BIN" ]; then
    SDB_BIN="sdb"  # Fallback: buscar en PATH
fi

$SDB_BIN connect 192.168.0.22 || true
sleep 2

# Verificar conexión
if ! $SDB_BIN devices | grep -q "192.168.0.22"; then
    echo -e "${RED}❌ No se pudo conectar a la TV en 192.168.0.22${NC}"
    echo "Intenta conectar manualmente: $SDB_BIN connect 192.168.0.22"
    exit 1
fi

echo -e "${GREEN}✓ TV conectada correctamente${NC}"

# ============================================
# PASO 2: Limpiar firmas antiguas y WGT anterior
# ============================================
echo -e "\n${YELLOW}[2/5] Limpiando firmas antiguas...${NC}"

rm -f "$BUILD_DIR/author-signature.xml" 2>/dev/null || true
rm -f "$BUILD_DIR/signature1.xml" 2>/dev/null || true
mkdir -p "$WGT_OUTPUT"
rm -f "$WGT_OUTPUT"/*.wgt 2>/dev/null || true

echo -e "${GREEN}✓ Firmas limpias${NC}"

# ============================================
# PASO 3: Empaquetar en WGT
# ============================================
echo -e "\n${YELLOW}[3/5] Generando paquete WGT...${NC}"

cd "$APP_PROJECT"
"$TIZEN_BIN" package -t wgt -s CleanProfile -o build/tizen -- build/web

# El WGT se genera en la carpeta de Tizen Studio, no en el proyecto
if [ ! -f "$WGT_OUTPUT"/*.wgt ]; then
    echo -e "${RED}❌ Error generando WGT${NC}"
    echo "Archivos en $WGT_OUTPUT:"
    ls -la "$WGT_OUTPUT" 2>/dev/null || echo "Carpeta no existe"
    exit 1
fi

WGT_FILE=$(ls -t "$WGT_OUTPUT"/*.wgt | head -n1)
WGT_BASENAME=$(basename "$WGT_FILE")
echo -e "${GREEN}✓ WGT creado: $WGT_BASENAME${NC}"

# ============================================
# PASO 3.5: Desinstalar versión anterior (si existe)
# ============================================
echo -e "\n${YELLOW}[3.5/5] Verificando versión anterior...${NC}"

"$TIZEN_BIN" uninstall -p "$APP_ID" -t "$TV_ID" 2>/dev/null || true
sleep 2

echo -e "${GREEN}✓ Versión anterior desinstalada (si existía)${NC}"

# ============================================
# PASO 4: Instalar en la TV
# ============================================
echo -e "\n${YELLOW}[4/5] Instalando en la TV...${NC}"

"$TIZEN_BIN" install -n "$WGT_BASENAME" -t "$TV_ID" -- "$WGT_OUTPUT"

echo -e "${GREEN}✓ Instalación completada${NC}"

# ============================================
# PASO 5: Lanzar la app en la TV
# ============================================
echo -e "\n${YELLOW}[5/5] Lanzando Kovalsky TV en la TV...${NC}"

"$TIZEN_BIN" run -p "$APP_ID" -t "$TV_ID"

echo -e "${GREEN}✅ ¡Kovalsky TV está corriendo en la TV!${NC}"
echo -e "\nPara detener la app manualmente:"
echo -e "  $SDB_BIN shell app_launcher -k $APP_ID"
