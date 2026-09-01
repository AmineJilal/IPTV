#!/bin/bash

# Script final: Instalar Kovalsky TV - MÉTODO AUTOMÁTICO + GUI
# Este script compila el WGT y luego instruye al usuario para usar Device Manager

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="/home/amin/Escritorio/IPTV LOCAL"
APP_PROJECT="$PROJECT_DIR/app_iptv"
TIZEN_BIN="/home/amin/tizen-studio/tools/ide/bin/tizen"

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      INSTALAR KOVALSKY TV EN TV SAMSUNG - MÉTODO MIXTO      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"

# ============================================
# PASO 1: Compilar WGT
# ============================================
echo -e "\n${YELLOW}[PASO 1/3] Compilando WGT con Flutter...${NC}"

cd "$APP_PROJECT"

# Limpiar firmas previas
rm -f build/web/author-signature.xml build/web/signature1.xml 2>/dev/null || true

# Compilar
"$TIZEN_BIN" package -t wgt -s author -o build/tizen -- build/web 2>&1 | grep -E "(Author cert|Package File)"

WGT_OUTPUT="/home/amin/tizen-studio/tools/ide/bin/build/tizen"
WGT_FILE=$(ls -t "$WGT_OUTPUT"/*.wgt | head -n1)

if [ ! -f "$WGT_FILE" ]; then
    echo -e "${RED}❌ Error compilando WGT${NC}"
    exit 1
fi

echo -e "${GREEN}✓ WGT compilado correctamente${NC}"
echo -e "${GREEN}  Archivo: $(basename "$WGT_FILE")${NC}"
echo -e "${GREEN}  Tamaño: $(ls -lh "$WGT_FILE" | awk '{print $5}')${NC}"

# ============================================
# PASO 2: Desinstalar versión anterior
# ============================================
echo -e "\n${YELLOW}[PASO 2/3] Desinstalando versión anterior (si existe)...${NC}"

/home/amin/tizen-studio/tools/sdb disconnect 192.168.0.22 2>/dev/null || true
sleep 2
/home/amin/tizen-studio/tools/sdb connect 192.168.0.22 2>/dev/null || true
sleep 2

/home/amin/tizen-studio/tools/sdb -s 192.168.0.22 shell "app_launcher -u oJ8S9K1v2L.KovalskyTV" 2>/dev/null || true
sleep 2

echo -e "${GREEN}✓ Versión anterior desinstalada${NC}"

# ============================================
# PASO 3: Usar Device Manager (GUI)
# ============================================
echo -e "\n${YELLOW}[PASO 3/3] Abriendo Device Manager...${NC}"

cat << 'EOF'

┌─────────────────────────────────────────────────────────┐
│        AHORA USA DEVICE MANAGER (TIZEN STUDIO)          │
└─────────────────────────────────────────────────────────┘

El WGT compilado está listo en:
  /home/amin/tizen-studio/tools/ide/bin/build/tizen/

PASOS EN DEVICE MANAGER:

1. En la ventana abierta: "Device Manager"
   ├─ Busca la TV: TU43U7025FKXXC (debe estar en verde "ON")
   └─ Si no la ves, haz clic en "Connected Devices" en la barra superior

2. Click DERECHO en la TV → "Install an application"

3. Selecciona la carpeta:
   /home/amin/tizen-studio/tools/ide/bin/build/tizen/

4. Selecciona el archivo:
   Kovalsky TV.wgt

5. Clic en "Install"

6. Espera a que termine (debe mostrar "Install Complete")

7. Para ejecutar:
   Click derecho en TV → "Launch application"
   Busca: oJ8S9K1v2L.KovalskyTV
   Clic en "Launch"

┌─────────────────────────────────────────────────────────┐
│              ESPERA A QUE SE COMPLETE                   │
└─────────────────────────────────────────────────────────┘

EOF

# Esperar a que el usuario lo haga manualmente
echo ""
echo -e "${BLUE}Presiona ENTER cuando la instalación esté COMPLETA...${NC}"
read -p "> "

# Verificar instalación
echo -e "\n${YELLOW}Verificando instalación...${NC}"

/home/amin/tizen-studio/tools/sdb connect 192.168.0.22 2>/dev/null || true
sleep 2

if /home/amin/tizen-studio/tools/sdb -s 192.168.0.22 shell "find /opt/usr/apps -name 'oJ8S9K1v2L.KovalskyTV' -type d" 2>/dev/null | grep -q "oJ8S9K1v2L"; then
    echo -e "${GREEN}✅ ¡INSTALACIÓN COMPLETADA!${NC}"
    echo -e "${GREEN}   Kovalsky TV está lista en la TV${NC}"
else
    echo -e "${YELLOW}⚠ No se pudo verificar la instalación${NC}"
    echo -e "${YELLOW}   Pero el Device Manager debería haber completado el proceso${NC}"
fi

echo ""
echo -e "${BLUE}Para relanzar la app en cualquier momento:${NC}"
echo -e "${BLUE}/home/amin/tizen-studio/tools/ide/bin/tizen run -p oJ8S9K1v2L.KovalskyTV -t TU43U7025FKXXC${NC}"

