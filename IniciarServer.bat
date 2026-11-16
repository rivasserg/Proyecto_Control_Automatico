@echo off
title Servidor Tanque de Agua
color 0A

echo Ubicandose en la carpeta del proyecto...
cd /d "C:\Users\chill\Desktop\tanquepid\tanquepid"

echo Verificando dependencias de Node...
if not exist node_modules (
   echo Carpeta node_modules no encontrada. Instalando dependencias...
 call npm install express
echo)

echo Iniciando servidor Node.js...
start /b node server.js

echo Esperando a que el servidor arranque...
timeout /t 3 /nobreak > nul

echo Abriendo Google Chrome en el dashboard...
start chrome http://192.168.1.249:3000/

echo ================================================
echo ¡Servidor iniciado y navegador abierto con éxito!
echo ================================================
pause