const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http'); 
const { Server } = require("socket.io"); 

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ==========================================
// 📻 WEBSOCKET (MANTIDO INTACTO)
// ==========================================
io.on('connection', (socket) => {
    socket.on('entrar_sala', (turma_id) => { socket.join('turma_' + turma_id); });
    socket.on('entrar_portaria', () => { socket.join('canal_portaria'); });
    socket.on('resposta_liberacao', async (dados) => {
        try {
            if (dados.status === 'liberado') {
                await pool.query('INSERT INTO registros_acesso (aluno_id, tipo_movimento) VALUES ($1, $2)', [dados.aluno_id, 'SAIDA']);
            }
            io.to('canal_portaria').emit('status_liberacao', dados);
        } catch (erro) {}
    });
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, 
});

app.get('/', (req, res) => { res.json({ mensagem: 'Servidor NovaLuz V2 Online! 🚀' }); });

// ==========================================
// 🚨 MÓDULO DA PORTARIA (MANTIDO INTACTO)
// ==========================================
app.post('/api/scan', async (req, res) => {
    const { qr_code } = req.body;
    if (!qr_code) return res.status(400).json({ erro: 'QR Code não fornecido' });
    try {
        const buscaAluno = await pool.query('SELECT * FROM alunos WHERE qr_code_hash = $1', [qr_code]);
        if (buscaAluno.rows.length > 0) {
            const aluno = buscaAluno.rows[0];
            await pool.query('INSERT INTO registros_acesso (aluno_id, tipo_movimento) VALUES ($1, $2)', [aluno.id, 'ENTRADA']);
            io.to('turma_' + aluno.turma_id).emit('atualizacao_sala', { tipo: 'ENTRADA', aluno: { nome: aluno.nome }, data_hora: new Date() });
            return res.json({ status: 'sucesso', tipo: 'entrada', mensagem: `${aluno.nome} entrou na escola.`, aluno: aluno.nome });
        }
        const buscaPai = await pool.query('SELECT * FROM responsaveis WHERE qr_code_hash = $1', [qr_code]);
        if (buscaPai.rows.length > 0) {
            const pai = buscaPai.rows[0];
            const buscaFilho = await pool.query('SELECT id, nome, turma_id FROM alunos WHERE id = $1', [pai.aluno_id]);
            const filho = buscaFilho.rows[0];
            io.to('turma_' + filho.turma_id).emit('solicitacao_saida', { aluno_id: filho.id, aluno_nome: filho.nome, responsavel_nome: pai.nome });
            return res.json({ status: 'sucesso', tipo: 'aguardando', mensagem: `${pai.nome} chegou. Aguardando professora...`, aluno: filho.nome, aluno_id: filho.id, responsavel: pai.nome });
        }
        return res.status(404).json({ erro: 'QR Code inválido.' });
    } catch (erro) { res.status(500).json({ erro: 'Erro interno' }); }
});

// DASHBOARD E RELATÓRIOS (MANTIDOS)
app.get('/api/historico', async (req, res) => {
    try { res.json((await pool.query(`SELECT r.tipo_movimento, r.data_hora, a.nome FROM registros_acesso r JOIN alunos a ON r.aluno_id = a.id WHERE r.data_hora::date = CURRENT_DATE ORDER BY r.data_hora DESC LIMIT 20`)).rows); } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});
app.get('/api/dashboard', async (req, res) => {
    try {
        const total = parseInt((await pool.query('SELECT COUNT(*) FROM alunos')).rows[0].count);
        const presentes = parseInt((await pool.query(`SELECT COUNT(DISTINCT aluno_id) FROM registros_acesso WHERE tipo_movimento = 'ENTRADA' AND data_hora::date = CURRENT_DATE`)).rows[0].count);
        const acessos = (await pool.query(`SELECT a.nome, r.tipo_movimento, r.data_hora FROM registros_acesso r JOIN alunos a ON r.aluno_id = a.id WHERE r.data_hora::date = CURRENT_DATE ORDER BY r.data_hora DESC LIMIT 5`)).rows;
        res.json({ total_alunos: total, presentes_hoje: presentes, ausentes: total - presentes, ultimos_acessos: acessos });
    } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});

// ==========================================
// 📅 NOVO: MÓDULO PEDAGÓGICO V2
// ==========================================
// Rota para Salvar ou Atualizar (Rascunho/Publicado)
app.post('/api/agenda', async (req, res) => {
    const { turma_id, planejamento, atividade, para_casa, recado_geral, data_agenda, status, materiais } = req.body;
    try {
        const check = await pool.query('SELECT id FROM agenda_diaria WHERE turma_id = $1 AND data_agenda = $2', [turma_id, data_agenda]);
        if (check.rows.length > 0) {
            await pool.query(`UPDATE agenda_diaria SET planejamento=$1, atividade=$2, para_casa=$3, recado_geral=$4, status=$5, materiais=$6 WHERE id=$7`, [planejamento, atividade, para_casa, recado_geral, status, materiais, check.rows[0].id]);
        } else {
            await pool.query(`INSERT INTO agenda_diaria (turma_id, planejamento, atividade, para_casa, recado_geral, data_agenda, status, materiais) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [turma_id, planejamento, atividade, para_casa, recado_geral, data_agenda, status, materiais]);
        }
        res.json({ mensagem: 'Agenda salva!' });
    } catch (erro) { res.status(500).json({ erro: 'Erro ao salvar' }); }
});

// Rota para a professora carregar a agenda de um dia específico para editar
app.get('/api/agenda/:turma_id/:data', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM agenda_diaria WHERE turma_id = $1 AND data_agenda = $2', [req.params.turma_id, req.params.data]);
        res.json(result.rows.length > 0 ? result.rows[0] : null);
    } catch(e) { res.status(500).json({erro: 'Erro'}); }
});

app.get('/api/planejamentos', async (req, res) => {
    try { res.json((await pool.query(`SELECT a.*, t.nome as nome_turma, u.nome as nome_professora FROM agenda_diaria a JOIN turmas t ON a.turma_id = t.id JOIN usuarios u ON t.professora_id = u.id ORDER BY a.data_agenda DESC LIMIT 50`)).rows); } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});

/// ==========================================
// 👨‍👩‍👦 PORTAL DOS PAIS (SEGURO COM CÓDIGO HASH)
// ==========================================
app.get('/api/agenda-pais/:hash/:data', async (req, res) => {
    try {
        // 👇 Agora ele busca pelo qr_code_hash e não mais pelo ID!
        const buscaAluno = await pool.query('SELECT turma_id, nome FROM alunos WHERE qr_code_hash = $1', [req.params.hash]);
        if(buscaAluno.rows.length === 0) return res.status(404).json({ erro: 'Aluno não encontrado' });
        
        const buscaAgenda = await pool.query(`SELECT atividade, para_casa, recado_geral FROM agenda_diaria WHERE turma_id = $1 AND data_agenda = $2 AND status = 'publicado'`, [buscaAluno.rows[0].turma_id, req.params.data]);
        
        if(buscaAgenda.rows.length === 0) return res.json({ publicada: false, mensagem: 'Nenhuma agenda publicada para este dia específico.' });
        
        res.json({ publicada: true, aluno: buscaAluno.rows[0].nome, agenda: buscaAgenda.rows[0] });
    } catch (erro) { res.status(500).json({ erro: 'Erro ao buscar' }); }
});

// CADASTROS E LISTAGENS (MANTIDOS)
app.get('/api/alunos', async (req, res) => {
    try { res.json((await pool.query(`SELECT a.id, a.nome, a.turma_id, COALESCE(t.nome, 'Sem Turma') as nome_turma, COALESCE(u.nome, 'Sem Prof') as nome_professora, a.qr_code_hash as qr_code, r.nome as nome_responsavel, r.qr_code_hash as qr_pai FROM alunos a LEFT JOIN responsaveis r ON a.id = r.aluno_id LEFT JOIN turmas t ON a.turma_id = t.id LEFT JOIN usuarios u ON t.professora_id = u.id ORDER BY a.nome ASC`)).rows); } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});
app.get('/api/turmas', async (req, res) => {
    try { res.json((await pool.query("SELECT id, nome FROM turmas")).rows); } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});
app.get('/api/professores', async (req, res) => {
    try { res.json((await pool.query("SELECT id, nome FROM usuarios WHERE perfil = 'professora'")).rows); } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});
app.put('/api/alunos/:id', async (req, res) => {
    try { await pool.query('UPDATE alunos SET nome = $1, turma_id = $2 WHERE id = $3', [req.body.nome, req.body.turma_id, req.params.id]); res.json({ mensagem: 'Atualizado!' }); } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});

// ==========================================
// 📚 MÓDULO DE LISTAS SUSPENSAS (V2.1)
// ==========================================
app.get('/api/materiais', async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM materiais ORDER BY nome ASC')).rows); } 
    catch (e) { res.status(500).json({ erro: 'Erro' }); }
});

app.get('/api/atividades', async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM atividades ORDER BY nome ASC')).rows); } 
    catch (e) { res.status(500).json({ erro: 'Erro' }); }
});

app.get('/api/bncc', async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM bncc ORDER BY codigo ASC')).rows); } 
    catch (e) { res.status(500).json({ erro: 'Erro' }); }
});

app.post('/api/atividades', async (req, res) => {
    // Para quando a professora quiser salvar uma atividade nova no futuro
    try { 
        await pool.query('INSERT INTO atividades (nome) VALUES ($1)', [req.body.nome]);
        res.json({ mensagem: 'Salvo' });
    } catch (e) { res.status(500).json({ erro: 'Erro' }); }
});

// Rota para a Diretora cadastrar novo Material Didático
app.post('/api/materiais', async (req, res) => {
    try { 
        await pool.query('INSERT INTO materiais (nome) VALUES ($1)', [req.body.nome]);
        res.json({ mensagem: 'Material cadastrado com sucesso!' });
    } catch (e) { res.status(500).json({ erro: 'Erro ao salvar material' }); }
});

// Rota para a Diretora cadastrar novo código BNCC
app.post('/api/bncc', async (req, res) => {
    try { 
        await pool.query('INSERT INTO bncc (codigo, descricao) VALUES ($1, $2)', [req.body.codigo, req.body.descricao]);
        res.json({ mensagem: 'Competência BNCC cadastrada!' });
    } catch (e) { res.status(500).json({ erro: 'Erro ao salvar BNCC' }); }
});


// ==========================================
// 🔐 LOGIN V2 (MÚLTIPLAS TURMAS)
// ==========================================
app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const buscaUser = await pool.query('SELECT id, nome, email, perfil FROM usuarios WHERE email = $1 AND senha = $2', [email, senha]);
        if (buscaUser.rows.length > 0) {
            const usuario = buscaUser.rows[0];
            let turmas = [];
            // Se for professora, busca TODAS as turmas vinculadas ao ID dela!
            if (usuario.perfil === 'professora') {
                const buscaTurmas = await pool.query('SELECT id, nome FROM turmas WHERE professora_id = $1', [usuario.id]);
                turmas = buscaTurmas.rows;
            }
            res.json({ sucesso: true, usuario: { ...usuario, turmas: turmas } });
        } else {
            res.status(401).json({ sucesso: false, mensagem: 'E-mail ou senha incorretos!' });
        }
    } catch (erro) { res.status(500).json({ sucesso: false, mensagem: 'Erro interno' }); }
});

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, '0.0.0.0', () => { console.log(`✅ Servidor V2 Ligado!`); });