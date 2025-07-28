# �� Taquarada - Portal do Debate Taquara Raiz

Portal web para acompanhamento da **Série B 2025** com foco especial no **Criciúma EC**. Sistema de gerenciamento de palpites e acompanhamento de resultados para o programa esportivo "Debate Taquara Raiz".

## �� Índice

- [Sobre o Projeto](#sobre-o-projeto)
- [Funcionalidades](#funcionalidades)
- [Tecnologias](#tecnologias)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Execução](#execução)
- [Acesso](#acesso)
- [Estrutura do Projeto](#estrutura-do-projeto)
- [Troubleshooting](#troubleshooting)

## �� Sobre o Projeto

O **Taquarada** é um portal web completo para acompanhamento da Série B 2025, desenvolvido especificamente para o programa "Debate Taquara Raiz". O sistema permite que apresentadores façam palpites sobre os jogos e acompanhem suas pontuações em um ranking competitivo.

### Características Principais:
- **Classificação completa** da Série B 2025
- **Sistema de palpites** para apresentadores
- **Ranking competitivo** com pontuação
- **Área administrativa** para gestão de dados
- **Foco especial** no Criciúma EC
- **Interface responsiva** e moderna

## ⚡ Funcionalidades

### 👥 Usuários
- **Apresentadores**: Taquarada, China, Professor Ghedin
- **Administrador**: Acesso completo ao sistema

### 🏟️ Módulos Principais
1. **Classificação**: Tabela completa da Série B com destaque para o Criciúma
2. **Palpites**: Interface para inserção de palpites por rodada
3. **Ranking**: Sistema de pontuação dos apresentadores
4. **Resultados**: Histórico de jogos e palpites
5. **Artilharia**: Ranking de goleadores
6. **Admin**: Gestão de placares, classificação e artilharia

### 🎮 Sistema de Pontuação
- **3 pontos**: Palpite exato (placar correto)
- **1 ponto**: Resultado correto (vitória/empate/derrota)
- **0 pontos**: Erro completo

## ��️ Tecnologias

- **Backend**: Node.js (HTTP nativo)
- **Banco de Dados**: SQLite3
- **Frontend**: HTML, CSS, JavaScript vanilla
- **Templates**: Sistema próprio de templates
- **Sessões**: Cookies simples

## 📋 Pré-requisitos

Antes de começar, certifique-se de ter instalado:

- **Node.js** (versão 12 ou superior)
  - Download: https://nodejs.org/
  - Verificar instalação: `node --version`

- **npm** (geralmente vem com o Node.js)
  - Verificar instalação: `npm --version`

## �� Instalação

### 1. Clone o Repositório
```bash
git clone [URL_DO_REPOSITÓRIO]
cd taquarada
```

### 2. Instale as Dependências
```bash
npm install sqlite3
```

### 3. Inicialize o Banco de Dados
```bash
node init_db.js
```
**Saída esperada**: `Tabelas criadas (ou já existentes) com sucesso!`

### 4. Importe os Dados Iniciais
```bash
node import_data.js
```
**Saída esperada**: `Dados importados com sucesso!`

### 5. Inicie o Servidor
```bash
node server.js
```
**Saída esperada**: `Servidor iniciado em http://localhost:3000`

## ⚙️ Configuração

### Variáveis de Ambiente (Opcional)
O servidor usa a porta 3000 por padrão. Para alterar:

```bash
# Windows
set PORT=8080
node server.js

# Linux/Mac
PORT=8080 node server.js
```

### Banco de Dados
- **Arquivo**: `database.db` (criado automaticamente)
- **Schema**: `schema.sql`
- **Dados iniciais**: Diretório `data/`

## 🌐 Execução

### Comando Completo
```bash
# Sequência completa de execução
npm install sqlite3
node init_db.js
node import_data.js
node server.js
```

### Script de Inicialização (Opcional)
Crie um arquivo `start.bat` (Windows) ou `start.sh` (Linux/Mac):

**Windows (start.bat)**:
```batch
@echo off
echo Iniciando Taquarada...
node server.js
pause
```

**Linux/Mac (start.sh)**:
```bash
#!/bin/bash
echo "Iniciando Taquarada..."
node server.js
```
