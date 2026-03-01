const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http'); 
const { Server } = require("socket.io"); 

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" } 
});

// ==========================================
// 📻 RÁDIO COMUNICADOR (WEBSOCKET)
// ==========================================
io.on('connection', (socket) => {
    console.log('⚡ Cliente conectado no Socket:', socket.id);

    socket.on('entrar_sala', (turma_id) => {
        const nomeSala = 'turma_' + turma_id;
        socket.join(nomeSala); 
        console.log('👩‍🏫 Professora sintonizou na rádio da:', nomeSala);
    });

    socket.on('entrar_portaria', () => {
        socket.join('canal_portaria');
        console.log('🚪 Portaria sintonizada no canal de respostas.');
    });

    socket.on('resposta_liberacao', async (dados) => {
        console.log('👩‍🏫 Resposta da professora recebida:', dados);
        try {
            if (dados.status === 'liberado') {
                await pool.query(
                    'INSERT INTO registros_acesso (aluno_id, tipo_movimento) VALUES ($1, $2)', 
                    [dados.aluno_id, 'SAIDA']
                );
            }
            io.to('canal_portaria').emit('status_liberacao', dados);
        } catch (erro) {
            console.error('Erro ao processar liberação:', erro);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Dispositivo desconectado:', socket.id);
    });
});

// ---------------------------------------------------------
// ⚠️ CONEXÃO SUPABASE
// ---------------------------------------------------------
const connectionString = process.env.DATABASE_URL; 

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }, 
});

app.get('/', (req, res) => {
    res.json({ mensagem: 'Servidor SaaS Online e Atualizado! 🚀' });
});

// ==========================================
// 🚨 MÓDULO DA PORTARIA INTELIGENTE
// ==========================================
app.post('/api/scan', async (req, res) => {
    const { qr_code } = req.body;
    if (!qr_code) return res.status(400).json({ erro: 'QR Code não fornecido' });

    try {
        const buscaAluno = await pool.query('SELECT * FROM alunos WHERE qr_code_hash = $1', [qr_code]);
        if (buscaAluno.rows.length > 0) {
            const aluno = buscaAluno.rows[0];
            await pool.query('INSERT INTO registros_acesso (aluno_id, tipo_movimento) VALUES ($1, $2)', [aluno.id, 'ENTRADA']);
            
            io.to('turma_' + aluno.turma_id).emit('atualizacao_sala', {
                tipo: 'ENTRADA',
                aluno: { nome: aluno.nome },
                data_hora: new Date()
            });
            
            return res.json({ status: 'sucesso', tipo: 'entrada', mensagem: `${aluno.nome} entrou na escola.`, aluno: aluno.nome });
        }

        const buscaPai = await pool.query('SELECT * FROM responsaveis WHERE qr_code_hash = $1', [qr_code]);
        if (buscaPai.rows.length > 0) {
            const pai = buscaPai.rows[0];
            const buscaFilho = await pool.query('SELECT id, nome, turma_id FROM alunos WHERE id = $1', [pai.aluno_id]);
            const filho = buscaFilho.rows[0];

            io.to('turma_' + filho.turma_id).emit('solicitacao_saida', {
                aluno_id: filho.id,
                aluno_nome: filho.nome,
                responsavel_nome: pai.nome
            });
            
            return res.json({ status: 'sucesso', tipo: 'aguardando', mensagem: `${pai.nome} chegou. Aguardando professora liberar ${filho.nome}...`, aluno: filho.nome, aluno_id: filho.id, responsavel: pai.nome });
        }
        return res.status(404).json({ erro: 'QR Code inválido.' });

    } catch (erro) {
        res.status(500).json({ erro: 'Erro interno no servidor da portaria.' });
    }
});

// ==========================================
// 📊 DASHBOARD E RELATÓRIOS
// ==========================================
app.get('/api/historico', async (req, res) => {
    try {
        const resultado = await pool.query(`SELECT r.tipo_movimento, r.data_hora, a.nome FROM registros_acesso r JOIN alunos a ON r.aluno_id = a.id WHERE r.data_hora::date = CURRENT_DATE ORDER BY r.data_hora DESC LIMIT 20`);
        res.json(resultado.rows);
    } catch (erro) { res.status(500).json({ erro: 'Erro histórico' }); }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        const totalAlunosQuery = await pool.query('SELECT COUNT(*) FROM alunos');
        const totalAlunos = parseInt(totalAlunosQuery.rows[0].count);

        const presentesHojeQuery = await pool.query(`SELECT COUNT(DISTINCT aluno_id) FROM registros_acesso WHERE tipo_movimento = 'ENTRADA' AND data_hora::date = CURRENT_DATE`);
        const presentesHoje = parseInt(presentesHojeQuery.rows[0].count);
        
        const ausentes = totalAlunos - presentesHoje;

        const ultimosAcessosQuery = await pool.query(`SELECT a.nome, r.tipo_movimento, r.data_hora FROM registros_acesso r JOIN alunos a ON r.aluno_id = a.id WHERE r.data_hora::date = CURRENT_DATE ORDER BY r.data_hora DESC LIMIT 5`);

        res.json({ total_alunos: totalAlunos, presentes_hoje: presentesHoje, ausentes: ausentes, ultimos_acessos: ultimosAcessosQuery.rows });
    } catch (erro) { res.status(500).json({ erro: 'Erro dashboard' }); }
});

app.get('/api/relatorio-frequencia', async (req, res) => {
    try {
        const query = `
            SELECT a.nome as aluno, COALESCE(t.nome, 'Sem Turma') as turma, r.tipo_movimento, r.data_hora
            FROM registros_acesso r
            JOIN alunos a ON r.aluno_id = a.id
            LEFT JOIN turmas t ON a.turma_id = t.id
            WHERE r.data_hora::date >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY r.data_hora DESC
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao gerar dados do relatório' });
    }
});

// ==========================================
// 📅 MÓDULO PEDAGÓGICO (AGENDA/AULAS)
// ==========================================
app.post('/api/agenda', async (req, res) => {
    const { turma_id, planejamento, atividade, para_casa, recado_geral, data_agenda } = req.body;
    try {
        await pool.query(`INSERT INTO agenda_diaria (turma_id, planejamento, atividade, para_casa, recado_geral, data_agenda) VALUES ($1, $2, $3, $4, $5, $6)`, [turma_id, planejamento, atividade, para_casa, recado_geral, data_agenda]);
        io.emit('nova_agenda', { mensagem: 'Planejamento salvo!' });
        res.json({ mensagem: 'Planejamento e Agenda salvos com sucesso!' });
    } catch (erro) { res.status(500).json({ erro: 'Erro ao salvar planejamento' }); }
});

app.get('/api/planejamentos', async (req, res) => {
    try {
        const query = `
            SELECT a.id, a.data_agenda, a.planejamento, a.atividade, a.para_casa, a.recado_geral, t.nome as nome_turma, u.nome as nome_professora
            FROM agenda_diaria a
            JOIN turmas t ON a.turma_id = t.id
            JOIN usuarios u ON t.professora_id = u.id
            ORDER BY a.data_agenda DESC, t.nome ASC LIMIT 50
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (erro) { res.status(500).json({ erro: 'Erro interno' }); }
});

// ==========================================
// 📋 MÓDULO DE CADASTROS E LISTAGENS
// ==========================================
app.get('/api/alunos', async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id, a.nome, a.turma_id, 
                COALESCE(t.nome, 'Sem Turma') as nome_turma,
                COALESCE(u.nome, 'Sem Prof') as nome_professora,
                a.qr_code_hash as qr_code, r.nome as nome_responsavel, r.qr_code_hash as qr_pai
            FROM alunos a
            LEFT JOIN responsaveis r ON a.id = r.aluno_id
            LEFT JOIN turmas t ON a.turma_id = t.id
            LEFT JOIN usuarios u ON t.professora_id = u.id
            ORDER BY a.nome ASC
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (erro) { res.status(500).json({ erro: 'Erro ao buscar alunos' }); }
});

app.get('/api/turmas', async (req, res) => {
    try {
        const resultado = await pool.query("SELECT id, nome FROM turmas");
        res.json(resultado.rows);
    } catch (erro) { res.status(500).json({ erro: 'Erro turmas' }); }
});

app.get('/api/professores', async (req, res) => {
    try {
        const resultado = await pool.query("SELECT id, nome FROM usuarios WHERE perfil = 'professora'");
        res.json(resultado.rows);
    } catch (erro) { res.status(500).json({ erro: 'Erro ao buscar professores' }); }
});

app.post('/api/novo-aluno', async (req, res) => {
    const { nome_aluno, turma_id, nome_pai, telefone_pai } = req.body;
    try {
        const codeAluno = `ALUNO-${Math.floor(Math.random() * 100000)}`;
        const codePai = `PAI-${Math.floor(Math.random() * 100000)}`;

        const novoAluno = await pool.query(`INSERT INTO alunos (nome, turma_id, qr_code_hash) VALUES ($1, $2, $3) RETURNING id`, [nome_aluno, turma_id, codeAluno]);
        await pool.query(`INSERT INTO responsaveis (nome, parentesco, telefone, aluno_id, qr_code_hash) VALUES ($1, 'Responsável', $2, $3, $4)`, [nome_pai, telefone_pai, novoAluno.rows[0].id, codePai]);

        res.json({ mensagem: 'Sucesso', qr_aluno: codeAluno, qr_pai: codePai });
    } catch (erro) { res.status(500).json({ erro: 'Erro ao cadastrar' }); }
});

app.post('/api/novo-professor', async (req, res) => {
    const { nome, email, senha } = req.body;
    try {
        await pool.query('INSERT INTO usuarios (nome, email, senha, perfil) VALUES ($1, $2, $3, $4)', [nome, email, senha, 'professora']);
        res.json({ mensagem: 'Professor(a) cadastrado!' });
    } catch (erro) { res.status(500).json({ erro: 'Erro ao cadastrar professor' }); }
});

app.post('/api/nova-turma', async (req, res) => {
    const { nome, professora_id } = req.body;
    try {
        await pool.query('INSERT INTO turmas (nome, professora_id) VALUES ($1, $2)', [nome, professora_id]);
        res.json({ mensagem: 'Turma criada com sucesso!' });
    } catch (erro) { res.status(500).json({ erro: 'Erro ao criar turma' }); }
});

// ==========================================
// ✏️ MÓDULO DE EDIÇÃO (PUT)
// ==========================================
app.put('/api/alunos/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, turma_id } = req.body;
    try {
        await pool.query('UPDATE alunos SET nome = $1, turma_id = $2 WHERE id = $3', [nome, turma_id, id]);
        res.json({ mensagem: 'Aluno atualizado com sucesso!' });
    } catch (erro) { res.status(500).json({ erro: 'Erro ao editar aluno' }); }
});

// ==========================================
// 🔐 LOGIN DO SISTEMA (AGORA INTELIGENTE)
// ==========================================
app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ sucesso: false, mensagem: 'Preencha e-mail e senha.' });

    try {
        const buscaUser = await pool.query('SELECT id, nome, email, perfil FROM usuarios WHERE email = $1 AND senha = $2', [email, senha]);
        
        if (buscaUser.rows.length > 0) {
            const usuario = buscaUser.rows[0];
            let turma_id = null;

            // 👇 A MÁGICA AQUI: Se for professora, descobre qual é a sala dela!
            if (usuario.perfil === 'professora') {
                const buscaTurma = await pool.query('SELECT id FROM turmas WHERE professora_id = $1 LIMIT 1', [usuario.id]);
                if (buscaTurma.rows.length > 0) {
                    turma_id = buscaTurma.rows[0].id;
                }
            }

            // Devolve o usuário e o número da turma (se tiver)
            res.json({ sucesso: true, usuario: { ...usuario, turma_id: turma_id } });
        } else {
            res.status(401).json({ sucesso: false, mensagem: 'E-mail ou senha incorretos!' });
        }
    } catch (erro) { 
        console.error('Erro no login:', erro);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' }); 
    }
});