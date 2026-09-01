#!/bin/bash

# Script de despliegue para Tizen (Kovalsky TV) - Usando certificado Samsung
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
SAMSUNG_CERT_DIR="/home/amin/SamsungCertificate/KovalskyProfile"

# Detectar instalación de Tizen
TIZEN_BIN="/home/amin/tizen-studio/tools/ide/bin/tizen"

if [ ! -f "$TIZEN_BIN" ]; then
    echo -e "${RED}❌ Tizen CLI no encontrado en: $TIZEN_BIN${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Tizen CLI encontrado: $TIZEN_BIN${NC}"

# ============================================
# PASO 1: Verificar certificado Samsung
# ============================================
echo -e "\n${YELLOW}[1/6] Verificando certificado Samsung...${NC}"

if [ ! -f "$SAMSUNG_CERT_DIR/author.p12" ]; then
    echo -e "${RED}❌ Certificado Samsung no encontrado en: $SAMSUNG_CERT_DIR${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Certificado Samsung encontrado${NC}"

# ============================================
# PASO 2: Conectar a la TV
# ============================================
echo -e "\n${YELLOW}[2/6] Conectando a la TV...${NC}"

SDB_BIN="/home/amin/tizen-studio/tools/sdb"

$SDB_BIN connect 192.168.0.22 || true
sleep 2

# Verificar conexión
if ! $SDB_BIN devices | grep -q "192.168.0.22"; then
    echo -e "${RED}❌ No se pudo conectar a la TV en 192.168.0.22${NC}"
    exit 1
fi

echo -e "${GREEN}✓ TV conectada correctamente${NC}"

# ============================================
# PASO 3: Limpiar firmas antiguas
# ============================================
echo -e "\n${YELLOW}[3/6] Limpiando firmas antiguas...${NC}"

rm -f "$BUILD_DIR/author-signature.xml" 2>/dev/null || true
rm -f "$BUILD_DIR/signature1.xml" 2>/dev/null || true

WGT_OUTPUT="$(dirname $TIZEN_BIN)/build/tizen"
mkdir -p "$WGT_OUTPUT"
rm -f "$WGT_OUTPUT"/*.wgt 2>/dev/null || true

echo -e "${GREEN}✓ Firmas limpias${NC}"

# ============================================
# PASO 4: Empaquetar en WGT con certificado Samsung
# ============================================
echo -e "\n${YELLOW}[4/6] Generando paquete WGT...${NC}"

cd "$APP_PROJECT"
"$TIZEN_BIN" package -t wgt -s KovalskyProfile -o build/tizen -- build/web

if [ ! -f "$WGT_OUTPUT"/*.wgt ]; then
    echo -e "${RED}❌ Error generando WGT${NC}"
    echo "Archivos en $WGT_OUTPUT:"
    ls -la "$WGT_OUTPUT" 2>/dev/null || echo "Carpeta no existe"
    exit 1
fi

WGT_FILE=$(ls -t "$WGT_OUTPUT"/*.wgt | head -n1)
WGT_BASENAME=$(basename "$WGT_FILE")

# Renombrar sin espacios
if [[ "$WGT_BASENAME" == *" "* ]]; then
    WGT_NEW_NAME="KovalskyTV.wgt"
    mv "$WGT_FILE" "$WGT_OUTPUT/$WGT_NEW_NAME"
    WGT_BASENAME="$WGT_NEW_NAME"
fi

echo -e "${GREEN}✓ WGT creado: $WGT_BASENAME${NC}"

# ============================================
# PASO 5: Desinstalar versión anterior (si existe)
# ============================================
echo -e "\n${YELLOW}[5/6] Verificando versión anterior...${NC}"

"$TIZEN_BIN" uninstall -p "$APP_ID" -t "$TV_ID" 2>/dev/null || true
sleep 2

echo -e "${GREEN}✓ Versión anterior desinstalada (si existía)${NC}"

# ============================================
# PASO 6: Instalar en la TV
# ============================================
echo -e "\n${YELLOW}[6/6] Instalando en la TV...${NC}"

"$TIZEN_BIN" install -n "$WGT_BASENAME" -t "$TV_ID" -- "$WGT_OUTPUT"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ ¡Kovalsky TV instalado correctamente!${NC}"
    
    echo -e "\n${YELLOW}Lanzando la app...${NC}"
    "$TIZEN_BIN" run -p "$APP_ID" -t "$TV_ID"
    echo -e "${GREEN}✅ ¡Kovalsky TV está corriendo en la TV!${NC}"
else
    echo -e "${RED}❌ Error instalando la app${NC}"
    exit 1
fi

echo -e "\nPara detener la app manualmente:"
echo -e "  $SDB_BIN shell app_launcher -k $APP_ID"
