@echo off
rem Compila o protótipo com as Ferramentas de Build do Visual Studio 2022.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cl /nologo /O2 /EHsc /std:c++17 /utf-8 /W3 passthrough.cpp /Fe:passthrough.exe
cl /nologo /O2 /EHsc /std:c++17 /utf-8 /W3 pulse.cpp /Fe:pulse.exe
