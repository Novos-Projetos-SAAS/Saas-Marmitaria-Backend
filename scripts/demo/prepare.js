import knex from 'knex';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDemoEnvironment } from './environment.js';
import { prepareDemoProvider, DEMO_KEY } from './provider.js';
import { encryptApiKey } from '../../src/utils/infinitepayCredentials.js';
import { hashPassword } from '../../src/utils/passwordUtils.js';

export async function prepareDemoSchema(admin,schema,purpose) {
    if(!/^(?:infinitepay_demo|iptest_[a-f0-9]{32}(?:_bootstrap)?)$/.test(schema)) throw new Error('Schema de demonstração recusado.');
    await admin.transaction(async trx=>{
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',['demo-schema:'+schema]);
        const exists=Boolean(await trx('information_schema.schemata').where({schema_name:schema}).first('schema_name'));
        if(exists){
            if(!await trx.schema.withSchema(schema).hasTable('demo_identity') ||
                (await trx('demo_identity').withSchema(schema).first())?.purpose !== purpose)
                throw new Error('Schema existente sem identidade correspondente; nada será sobrescrito.');
            return;
        }
        await trx.schema.createSchema(schema);
        await trx.schema.withSchema(schema).createTable('demo_identity',t=>{t.text('purpose').primary();t.boolean('initialized').notNullable().defaultTo(false);});
        await trx('demo_identity').withSchema(schema).insert({purpose});
    });
}
export async function prepareDemo() {
    const profile=await loadDemoEnvironment();
    const connection={host:'127.0.0.1',port:55439,database:'infinitepay_phase1_test',user:'codex_test',password:''};
    const admin=knex({client:'pg',connection});let db;
    try {
        const actual=(await admin.raw('SELECT current_database() AS name,host(inet_server_addr()) AS host')).rows[0];
        if(actual.name !== connection.database || actual.host !== '127.0.0.1') throw new Error('Banco de demonstração recusado.');
        await prepareDemoSchema(admin,'infinitepay_demo',profile.purpose);
        db=knex({client:'pg',connection,searchPath:['infinitepay_demo'],migrations:{directory:fileURLToPath(new URL('../../src/database/migrations/',import.meta.url)),schemaName:'infinitepay_demo'}});
        const marker=await db('demo_identity').first();if(marker?.purpose !== profile.purpose) throw new Error('Identidade de schema recusada.');
        await db.migrate.latest();await prepareDemoProvider(db);
        if(!marker.initialized) await db.transaction(async trx=>{
            await trx('niveis_acesso').insert({id:1,nome:'admin',descricao:'DEMO SINTETICA'});
            await trx('usuarios').insert({id:1,nome:'ADMIN DEMO SINTETICO',email:'admin@demo.invalid',senha_hash:await hashPassword(profile.adminPassword),nivel_acesso_id:1,ativo:true});
            const [permission]=await trx('permissoes').insert({nome:'admin',descricao:'Apenas demonstração local'}).returning('*');
            await trx('permissoes_usuarios').insert({usuario_id:1,permissao_id:permission.id});
            await trx('dados_empresa').insert({id:1,nome_proprietario:'OPERADOR SINTETICO',razao_social:'DEMONSTRACAO SEM VALOR FINANCEIRO',nome_fantasia:'Marmitaria — DEMONSTRAÇÃO LOCAL',
                cnpj:'00000000000000',telefone_empresa:'11999999999',cep:'00000000',logradouro:'Rua Sintética',numero:'1',bairro:'Teste',cidade:'Teste',estado:'SP',imprimir_automaticamente:false,nome_impressora:null});
            await trx('status_loja').insert({id:1,esta_aberta:true});
            await trx('metodos_pagamento').insert([{id:1,nome:'Pix',codigo:'PIX',tipo_financeiro:'PIX'},{id:2,nome:'Dinheiro',codigo:'DINHEIRO',tipo_financeiro:'DINHEIRO'},
                {id:3,nome:'Cartão de Crédito',codigo:'CARTAO_CREDITO',tipo_financeiro:'CREDITO'},{id:4,nome:'Cartão de Débito',codigo:'CARTAO_DEBITO',tipo_financeiro:'DEBITO'}]);
            await trx('tamanhos_marmitas').insert([{nome:'P',preco_base:15},{nome:'M',preco_base:20},{nome:'G',preco_base:25}]);
            for(const [nome,foods]of [['Arroz',['Arroz branco DEMO','Arroz integral DEMO']],['Feijão',['Feijão DEMO']],['Proteína',['Frango DEMO','Carne DEMO']],['Salada',['Salada DEMO']]]){
                const [category]=await trx('categorias_alimentos').insert({nome,limite_escolhas:1}).returning('*');
                await trx('alimentos').insert(foods.map(name=>({nome:name,categoria_id:category.id,disponivel_hoje:true})));
            }
            await trx('marmitas_especiais').insert(['Frango','Carne','Vegetariana','Executiva'].map((name,i)=>({nome:'DEMO '+name,descricao:'Pedido sintético, sem cozinha ou impressão real.',preco:22+i,ativo:true})));
            const [category]=await trx('categorias_produtos').insert({nome:'Complementos DEMO'}).returning('*');
            await trx('produtos').insert([{nome:'Água DEMO',preco:3},{nome:'Sobremesa DEMO',preco:5}].map(item=>({...item,categoria_produto_id:category.id,ativo:true,disponivel_hoje:true})));
            const seedName=(await readdir(new URL('../../src/database/seeds/',import.meta.url))).find(name=>name.startsWith('06_'));
            await (await import(new URL('../../src/database/seeds/'+seedName,import.meta.url))).seed(trx);
            const [credential]=await trx('infinitepay_credenciais').insert({handle:'demo-sintetica',...encryptApiKey(DEMO_KEY,'demo-sintetica')}).returning('*');
            await trx('config_infinitepay').where({id:1}).update({handle:credential.handle,credencial_atual_id:credential.id,ativo:true});
            for(const table of ['niveis_acesso','usuarios','dados_empresa','status_loja','metodos_pagamento'])
                await trx.raw("SELECT setval(pg_get_serial_sequence(?, 'id'),GREATEST(COALESCE(max(id),1),1),true) FROM ??",[table,table]);
            await trx('demo_identity').update({initialized:true});
        });
        console.log('Demonstração preparada: banco local55439, schema infinitepay_demo. Dados anteriores preservados.');
    } catch {console.error('Preparação indisponível. Nenhum banco alternativo será utilizado.');process.exitCode=1;}
    finally {await db?.destroy();await admin.destroy();}
}
if(process.argv[1] === fileURLToPath(import.meta.url)) await prepareDemo();
