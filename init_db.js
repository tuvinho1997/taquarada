/*
 * Script de inicialização do banco SQLite para o Debate Taquara Raiz.
 *
 * Este script lê o arquivo schema.sql (na mesma pasta) e cria todas as
 * tabelas necessárias dentro de `database.db`. Execute-o uma única vez
 * antes de iniciar o servidor para que o banco de dados esteja pronto.
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Caminhos relativos à pasta atual (website)
const dbFile = path.join(__dirname, 'database.db');
const schemaFile = path.join(__dirname, 'schema.sql');

// Lê o conteúdo do arquivo de esquema
const schemaSQL = fs.readFileSync(schemaFile, 'utf8');

// Cria ou abre o banco de dados
const db = new sqlite3.Database(dbFile);

// Executa todas as instruções contidas no schema.sql
db.exec(schemaSQL, (err) => {
  if (err) {
    console.error('Erro ao criar as tabelas:', err.message);
  } else {
    console.log('Tabelas criadas (ou já existentes) com sucesso!');
  }
  db.close();
});