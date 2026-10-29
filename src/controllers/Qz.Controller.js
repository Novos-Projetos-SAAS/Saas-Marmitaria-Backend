// import crypto from 'crypto';
// import fs from 'fs';
// import path from 'path';

// // Lê o arquivo da chave privada que você colocou na raiz do projeto
// const privateKeyPath = path.resolve('private-key.pem');
// // const PRIVATE_KEY = fs.readFileSync(privateKeyPath, 'utf8');
// const PRIVATE_KEY = process.env.QZ_PRIVATE_KEY ? process.env.QZ_PRIVATE_KEY.replace(/\\n/g, '\n') : fs.readFileSync(privateKeyPath, 'utf8');

// export const assinarRequisicaoQZ = (req, res) => {
//     // O QZ Tray envia uma string aleatória (desafio) chamada "request"
//     const { request } = req.body; 
    
//     if (!request) {
//         return res.status(400).json({ error: 'String de requisição ausente.' });
//     }

//     try {
//         // Cria a assinatura usando SHA-512 e a sua chave privada
//         const signer = crypto.createSign('RSA-SHA512');
//         signer.update(request);
//         const signature = signer.sign(PRIVATE_KEY, 'base64');
        
//         // Retorna a assinatura em base64 pura
//         return res.status(200).send(signature);
//     } catch (error) {
//         console.error("Erro ao assinar QZ Tray:", error);
//         return res.status(500).json({ error: 'Erro interno ao assinar a requisição.' });
//     }
// };

/* ------------------------------------ */

// import crypto from "crypto";
// import fs from "fs";
// import path from "path";

// const PRIVATE_KEY = fs.readFileSync(
//     path.resolve("private-key.pem"),
//     "utf8"
// );

// export const assinarRequisicaoQZ = (req, res) => {
//     try {
//         const { request } = req.body;

//         console.log("Request:", request);

//         const signer = crypto.createSign("RSA-SHA512");

//         signer.update(request);
//         signer.end();

//         const assinatura = signer.sign(PRIVATE_KEY, "base64");

//         console.log("Assinatura gerada:", assinatura.substring(0, 50) + "...");

//         res.send(assinatura);

//     } catch (e) {
//         console.error(e);
//         res.status(500).send(e.message);
//     }
// };

/* ------------------------------------ */

import crypto from "crypto";
// Não precisamos mais do 'fs' e do 'path' aqui

// Função auxiliar para resgatar e formatar a chave
const getPrivateKey = () => {
    const rawKey = process.env.QZ_PRIVATE_KEY;
    
    if (!rawKey) {
        throw new Error("A variável de ambiente QZ_PRIVATE_KEY não está definida.");
    }

    // Procura pela string literal "\n" (escapada com duplo '\') 
    // e substitui por uma quebra de linha real '\n'
    return rawKey.replace(/\\n/g, '\n');
};

export const assinarRequisicaoQZ = (req, res) => {
    try {
        const { request } = req.body;


        // Pega a chave já formatada
        const privateKey = getPrivateKey();

        const signer = crypto.createSign("RSA-SHA512");

        signer.update(request);
        signer.end();

        // Assina usando a chave que veio do .env
        const assinatura = signer.sign(privateKey, "base64");


        res.send(assinatura);

    } catch (e) {
        res.status(500).send('Assinatura QZ indisponível.');
    }
};
