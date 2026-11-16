@echo off
title Ver Todas las Tablas - Tanquepid
color 0B
echo ========================================================
echo       ESTRUCTURA Y REGISTROS DE TODAS LAS TABLAS
echo ========================================================
echo.

echo [1/2] Consultando tabla: USUARIOS
echo --------------------------------------------------------
"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -u root -p -D tanquepid_db -e "DESCRIBE usuarios; SELECT * FROM usuarios;"
echo.
echo ========================================================

echo [2/2] Consultando tabla: TANQUES
echo --------------------------------------------------------
"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -u root -p -D tanquepid_db -e "DESCRIBE tanques; SELECT * FROM tanques;"
echo.
echo ========================================================
echo Consulta finalizada.
pause