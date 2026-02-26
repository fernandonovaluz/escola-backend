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

io.on('connection', (socket) => {
    console.log('⚡ Cliente conectado no Socket:', socket.id);
});

// ---------------------------------------------------------
// ⚠️ CONEXÃO SUPABASE (Verifique se sua senha está correta aqui)
// ---------------------------------------------------------
const connectionString = process.env.DATABASE_URL; 

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }, 
});
// ---------------------------------------------------------

app.get('/', (req, res) => {
    res.json({ mensagem: 'Servidor SaaS Online e Atualizado! 🚀' });
});

app.get('/api/alunos', async (req, res) => {
    try {
        // O segredo está aqui: JOIN (juntar) a tabela alunos com responsaveis
        const query = `
            SELECT 
                alunos.id,
                alunos.nome,
                alunos.turma_id,
                alunos.qr_code_hash as qr_code,
                responsaveis.nome as nome_responsavel,
                responsaveis.qr_code_hash as qr_pai
            FROM alunos
            LEFT JOIN responsaveis ON alunos.id = responsaveis.aluno_id
        `;

        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao buscar alunos' });
    }
});

// ==========================================
// 🚨 ROTA DA PORTARIA INTELIGENTE (SCAN)
// ==========================================
app.post('/api/scan', async (req, res) => {
    const { qr_code } = req.body;

    if (!qr_code) {
        return res.status(400).json({ erro: 'QR Code não fornecido' });
    }

    try {
        // 1. Tenta achar o QR Code na tabela de ALUNOS (Sinal de ENTRADA 🟢)
        const buscaAluno = await pool.query('SELECT * FROM alunos WHERE qr_code_hash = $1', [qr_code]);
        
        if (buscaAluno.rows.length > 0) {
            const aluno = buscaAluno.rows[0];
            
            // Aqui futuramente podemos salvar no banco o horário da entrada
            
            return res.json({ 
                status: 'sucesso', 
                tipo: 'entrada', 
                mensagem: `${aluno.nome} entrou na escola.`,
                aluno: aluno.nome
            });
        }

        // 2. Tenta achar o QR Code na tabela de RESPONSÁVEIS (Sinal de SAÍDA 🟠)
        const buscaPai = await pool.query('SELECT * FROM responsaveis WHERE qr_code_hash = $1', [qr_code]);
        
        if (buscaPai.rows.length > 0) {
            const pai = buscaPai.rows[0];
            
            // Vamos descobrir o nome do aluno que esse pai veio buscar para a mensagem ficar legal
            const buscaFilho = await pool.query('SELECT nome FROM alunos WHERE id = $1', [pai.aluno_id]);
            const nomeFilho = buscaFilho.rows[0].nome;

            // Aqui futuramente podemos salvar no banco o horário da saída
            
            return res.json({ 
                status: 'sucesso', 
                tipo: 'saida', 
                mensagem: `${pai.nome} veio buscar ${nomeFilho}. Liberação autorizada!`,
                aluno: nomeFilho,
                responsavel: pai.nome
            });
        }

        // 3. Se não achou em nenhuma das duas tabelas (QR Code Inválido 🔴)
        return res.status(404).json({ erro: 'QR Code inválido ou não cadastrado no sistema.' });

    } catch (erro) {
        console.error('Erro na portaria:', erro);
        res.status(500).json({ erro: 'Erro interno no servidor da portaria.' });
    }
});

// 2. Rota Registrar Acesso (Portaria Inteligente)
app.post('/api/registrar-acesso', async (req, res) => {
    const { qr_code, tipo } = req.body; 
    console.log(`🔔 Leitura (${tipo}):`, qr_code);
    
    try {
        let alunoAlvo = null;
        let mensagemLog = "";
        let nomeResponsavel = null;

        // Busca se é Aluno
        const buscaAluno = await pool.query('SELECT * FROM alunos WHERE qr_code_hash = $1', [qr_code]);
        
        if (buscaAluno.rows.length > 0) {
            alunoAlvo = buscaAluno.rows[0];
            mensagemLog = (tipo === 'ENTRADA') 
                ? `O aluno ${alunoAlvo.nome} ENTROU (Crachá Próprio).`
                : `O aluno ${alunoAlvo.nome} SAIU (Crachá Próprio).`;
        } else {
            // Busca se é Pai
            const buscaPai = await pool.query('SELECT * FROM responsaveis WHERE qr_code_hash = $1', [qr_code]);
            if (buscaPai.rows.length > 0) {
                const pai = buscaPai.rows[0];
                nomeResponsavel = pai.nome;
                const buscaFilho = await pool.query('SELECT * FROM alunos WHERE id = $1', [pai.aluno_id]);
                if (buscaFilho.rows.length > 0) {
                    alunoAlvo = buscaFilho.rows[0];
                    mensagemLog = (tipo === 'ENTRADA')
                        ? `O aluno ${alunoAlvo.nome} ENTROU com ${pai.nome}.`
                        : `SAÍDA: ${alunoAlvo.nome} buscado por ${pai.nome} (${pai.parentesco}).`;
                }
            }
        }

        if (alunoAlvo) {
            await pool.query('INSERT INTO registros_acesso (aluno_id, tipo_movimento) VALUES ($1, $2)', [alunoAlvo.id, tipo]);

            io.emit('atualizacao_sala', { 
                mensagem: mensagemLog,
                tipo: tipo,
                aluno: alunoAlvo,
                responsavel: nomeResponsavel,
                horario: new Date()
            });

            return res.json({ mensagem: 'Acesso Autorizado!', detalhe: mensagemLog, aluno: alunoAlvo.nome });
        } 
        
        return res.status(404).json({ mensagem: 'QR Code Desconhecido!' });

    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro no servidor' });
    }
});

// 3. Rota Histórico do Dia
app.get('/api/historico', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT r.tipo_movimento, r.data_hora, a.nome 
             FROM registros_acesso r
             JOIN alunos a ON r.aluno_id = a.id
             WHERE r.data_hora::date = CURRENT_DATE
             ORDER BY r.data_hora DESC LIMIT 20`
        );
        res.json(resultado.rows);
    } catch (erro) {
        res.status(500).json({ erro: 'Erro histórico' });
    }
});

// 4. Rota Agenda (Completa) 📅
app.post('/api/agenda', async (req, res) => {
    const { turma_id, atividade, para_casa, recado_geral } = req.body;
    try {
        await pool.query(
            `INSERT INTO agenda_diaria (turma_id, atividade, para_casa, recado_geral) 
             VALUES ($1, $2, $3, $4)`,
            [turma_id, atividade, para_casa, recado_geral]
        );
        io.emit('nova_agenda', { mensagem: 'Agenda atualizada!' });
        res.json({ mensagem: 'Agenda salva!' });
    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao salvar agenda' });
    }
});

// 5. Rota Dashboard 📊
app.get('/api/dashboard', async (req, res) => {
    try {
        const totalAlunos = await pool.query('SELECT COUNT(*) FROM alunos');
        const presentesHoje = await pool.query(
            `SELECT COUNT(DISTINCT aluno_id) FROM registros_acesso 
             WHERE tipo_movimento = 'ENTRADA' AND data_hora::date = CURRENT_DATE`
        );
        res.json({
            total_alunos: totalAlunos.rows[0].count,
            presentes_hoje: presentesHoje.rows[0].count
        });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro dashboard' });
    }
});

// 6. Rota NOVO ALUNO (Essa que estava faltando!) 📝
app.post('/api/novo-aluno', async (req, res) => {
    const { nome_aluno, turma_id, nome_pai, telefone_pai } = req.body;
    
    try {
        const codeAluno = `ALUNO-${Math.floor(Math.random() * 100000)}`;
        const codePai = `PAI-${Math.floor(Math.random() * 100000)}`;

        // Insere Aluno
        const novoAluno = await pool.query(
            `INSERT INTO alunos (nome, turma_id, qr_code_hash) VALUES ($1, $2, $3) RETURNING id`,
            [nome_aluno, turma_id, codeAluno]
        );
        const alunoId = novoAluno.rows[0].id;

        // Insere Pai
        await pool.query(
            `INSERT INTO responsaveis (nome, parentesco, telefone, aluno_id, qr_code_hash) 
             VALUES ($1, 'Responsável', $2, $3, $4)`,
            [nome_pai, telefone_pai, alunoId, codePai]
        );

        res.json({ mensagem: 'Sucesso', qr_aluno: codeAluno, qr_pai: codePai });

    } catch (erro) {
        console.error("Erro no cadastro:", erro);
        res.status(500).json({ erro: 'Erro ao cadastrar' });
    }
});

server.listen(PORT, () => {
    console.log(`Servidor Atualizado rodando na porta ${PORT}`);
});