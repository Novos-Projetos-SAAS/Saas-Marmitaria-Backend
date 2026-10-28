import express from 'express';
import cookieParser from 'cookie-parser';
import {createServer,request as httpsRequest} from 'node:https';
import {randomBytes,randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {syntheticProductionEnvironment} from './productionEnvironment.js';
import {encryptApiKey} from '../../src/utils/infinitepayCredentials.js';
import {createProductionAuthorizer} from '../../src/services/productionAuthorizer.js';
import {createProductionControlRouter} from '../../src/routes/InfinitepayProductionControl.Routes.js';
import {configureProductionProxy} from '../../src/config/infinitepayProduction.js';
import {initializeInfinitepayApplication,validateInfinitepayEnvironment} from '../../src/infinitepayApplication.js';
import {createSyntheticOrderDestination} from '../../src/homologation/syntheticOrderDestination.js';
import {createDurableOrderConsumer} from '../../src/services/durableOrderConsumer.js';
import {createProductionDiagnostics} from '../../src/services/productionDiagnostics.js';
import {createProductionLogoutBridge} from '../../src/middlewares/productionLogoutBridge.js';
import {logout} from '../../src/utils/logoutResponse.js';
import paymentRoutes from '../../src/routes/Pagamentos.Routes.js';

const flag={WORKER:'INFINITEPAY_WORKER_ENABLED',CREATE_LINK:'INFINITEPAY_CHECKOUT_ENABLED',VERIFY_PAYMENT:'INFINITEPAY_VERIFY_ENABLED',DELIVER_ORDER:'INFINITEPAY_DELIVERY_ENABLED'};
export async function createPreproductionFixture(options) {
    const previous=Object.fromEntries(['NODE_ENV','INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY_VERSION'].map(key=>[key,process.env[key]]));
    const f={db:options.db,schema:options.schema,clock:new Date(options.clock || Date.now()),sessionSecret:options.sessionSecret || randomBytes(32).toString('base64'),
        receiverSecret:options.receiverSecret || randomBytes(32),encryptionKey:options.encryptionKey || randomBytes(32).toString('base64'),
        destination:'synthetic-order-destination',caps:['WORKER','CREATE_LINK','VERIFY_PAYMENT','DELIVER_ORDER'],receiverMode:'success',
        provider:{counts:{links:0,checks:0},paid:true,timeout:false},backupMetadata:options.backupMetadata};
    process.env.NODE_ENV='production';process.env.INFINITEPAY_ENCRYPTION_KEY=f.encryptionKey;
    delete process.env.INFINITEPAY_ENCRYPTION_KEYS;delete process.env.INFINITEPAY_ENCRYPTION_KEY_VERSION;
    f.env=syntheticProductionEnvironment(options.connection);f.env.INFINITEPAY_DATABASE_ID=options.identity || randomUUID();
    const now=()=>new Date(f.clock),instances=[];let server,port,closed=false;
    const denied=()=>{throw new Error('Operação sintética não autorizada.');};
    f.advance=ms=>{f.clock=new Date(f.clock.getTime()+ms);};
    f.context=operation=>({operation,database:f.env.INFINITEPAY_DATABASE_NAME,databaseId:f.env.INFINITEPAY_DATABASE_ID,
        deploymentId:f.env.INFINITEPAY_DATABASE_ID,environment:'production',publicOrigin:f.env.INFINITEPAY_PUBLIC_ORIGIN,
        ...(operation==='DELIVER_ORDER'?{destinationId:f.destination}:{})});
    const authorizer=()=>createProductionAuthorizer({db:f.db,env:f.env,now,sessionSecret:()=>f.sessionSecret});
    const transport=async(url,init)=>{
        if(init?.method!=='POST' || init.headers?.['X-Api-Key']!=='SYNTHETIC_PREPROD_KEY')denied();
        const body=JSON.parse(init.body);
        if(url==='https://api.checkout.infinitepay.io/links') {
            f.provider.counts.links++;if(f.provider.timeout)throw Object.assign(new Error('SYNTHETIC_TIMEOUT'),{code:'ETIMEDOUT'});
            return {status:200,json:async()=>({url:'https://checkout.infinitepay.io/SYNTHETIC-'+body.order_nsu})};
        }
        if(url!=='https://api.checkout.infinitepay.io/payment_check')denied();
        f.provider.counts.checks++;
        const payment=await f.db('pagamentos as p').join('pedidos as o','o.id','p.pedido_id').join('metodos_pagamento as m','m.id','o.metodo_pagamento_id')
            .where('p.order_nsu',body.order_nsu).first('p.valor_centavos','m.codigo');
        if(!payment)denied();
        await f.provider.onCheck?.();
        return {status:200,json:async()=>({success:true,paid:f.provider.paid,amount:Number(payment.valor_centavos),
            paid_amount:Number(payment.valor_centavos)+(payment.codigo==='CARTAO_CREDITO'?10:0),installments:1,
            capture_method:payment.codigo==='PIX'?'pix':'credit_card',order_nsu:body.order_nsu,transaction_nsu:body.transaction_nsu,slug:body.slug,
            receipt_url:'https://recibo.infinitepay.io/'+body.transaction_nsu})};
    };
    f.instance=async({destination=f.destination}={})=>{
        const app=express();configureProductionProxy(app,validateInfinitepayEnvironment(f.env));
        const a=authorizer(),receiver=await createSyntheticOrderDestination({db:f.db,secret:f.receiverSecret,id:destination,now,behavior:()=>f.receiverMode});
        const adapter={...receiver,async send(...args){const receipt=await receiver.send(...args);await f.onReceived?.();return receipt;}};
        const service=await initializeInfinitepayApplication({app,db:f.db,env:f.env,now,productionAuthorization:a.authorize,operationalAdapter:adapter,transport});
        const instance={authorizer:a,service,receiver,app};instances.push(instance);return instance;
    };
    f.request=(path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
        const payload=body===undefined?undefined:JSON.stringify(body);
        const request=httpsRequest({hostname:'127.0.0.1',port,path,method,servername:'localhost',ca:options.tls.cert,
            headers:{Host:'backend.invalid.test','X-Forwarded-For':'203.0.113.71','X-Forwarded-Proto':'https',Origin:'https://shop.invalid.test',
                Cookie:'token='+f.session.token,'X-Infinitepay-CSRF':f.session.csrf || '',
                ...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}),...headers}},response=>{
            let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>{
                try{resolve({status:response.statusCode,headers:response.headers,data:JSON.parse(text)});}catch{reject(new Error('Resposta sintética inválida.'));}
            });
        });request.setTimeout(15000,()=>request.destroy(new Error('HTTPS local indisponível.')));request.on('error',reject);request.end(payload);
    });
    async function mount() {
        const first=await f.instance();f.authorizer=first.authorizer;f.service=first.service;f.receiver=first.receiver;
        const app=first.app;app.use(cookieParser(),express.json());
        app.use('/control',createProductionControlRouter({authorizer:f.authorizer}));
        app.use('/pagamentos',paymentRoutes);
        app.post('/legacy/logout',logout);app.post('/admin/logout',createProductionLogoutBridge({authorizer:f.authorizer,logout}));
        const diagnostics=createProductionDiagnostics({db:f.db,authorizer:f.authorizer,application:f.service,now});
        app.get('/diagnostics',async(req,res)=>{
            try{res.set('Cache-Control','no-store').json(await diagnostics.read({session:{token:req.cookies?.token,origin:req.get('Origin'),csrf:req.get('X-Infinitepay-CSRF')}}));}
            catch(error){res.status(error.statusCode).json({status:'fail',code:error.code});}
        });
        app.use((error,req,res,next)=>res.status(error.statusCode || 503).json({status:'fail',code:'SYNTHETIC_REQUEST_FAILED'}));
        server=createServer(options.tls,app);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});port=server.address().port;
    }
    f.quiesce=async()=>{
        const results=await Promise.allSettled(instances.splice(0).map(instance=>instance.service.stop()));
        if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=undefined;}
        if(results.some(result=>result.status==='rejected'))throw new Error('Encerramento sintético incompleto.');
    };
    f.login=()=>{const seconds=f.clock.getTime()/1000|0;f.session={token:jwt.sign({id:f.actor.id,iat:seconds,exp:seconds+3600,jti:randomUUID()},f.sessionSecret,{algorithm:'HS256'}),origin:'https://shop.invalid.test'};};
    f.bootstrap=async()=>{const response=await f.request('/control/csrf');if(response.status!==200)denied();f.session.csrf=response.data.data.csrfToken;};
    f.approve=async(caps=f.caps)=>{
        const response=await f.request('/control/approvals',{method:'POST',body:{capabilities:caps,...(caps.includes('DELIVER_ORDER')?{destinationId:f.destination}:{})}});
        if(response.status!==201)denied();return response.data.data;
    };
    f.enable=async(caps=f.caps)=>{
        for(const [cap,name] of Object.entries(flag))f.env[name]=caps.includes(cap)?'true':'false';
        if(caps.includes('CREATE_LINK'))await f.db('config_infinitepay').where({id:1}).update({ativo:true});
        await f.service.start({intervalMs:60000});
        for(let n=0;n<200 && f.service.status().cycles===0;n++)await new Promise(resolve=>setTimeout(resolve,10));
        if(!f.service.status().cycles)denied();
    };
    f.restart=async()=>{await f.quiesce();f.receiverMode='success';f.onReceived=undefined;for(const name of Object.values(flag))f.env[name]='false';await mount();};
    f.restartDatabase=async()=>{await f.quiesce();f.db=await options.restartDatabase(f.db);await f.restart();};
    f.order=async(method='PIX')=>{
        const m=await f.db('metodos_pagamento').where({codigo:method}).first(),size=await f.db('tamanhos_marmitas').first();
        const [order]=await f.db('pedidos').insert({nome_cliente:'SYNTHETIC',telefone_cliente:'00000000000',tipo_pedido:'Remoto',metodo_entrega:'Retirada',
            metodo_pagamento_id:m.id,valor_total:1,fluxo_pagamento:'INFINITEPAY'}).returning('*');
        await f.db('itens_pedido').insert({pedido_id:order.id,tamanho_marmita_id:size.id,quantidade:1,preco_unitario:1,subtotal:1,nome_item_snapshot:'SYNTHETIC'});return order;
    };
    f.checkout=(order,clientRequestId)=>f.service.runtime.resume(order.id,{client_request_id:clientRequestId});
    f.paidEvent=async order=>{
        const payment=await f.db('pagamentos').where({pedido_id:order.id}).first();
        const body={event_type:'paid',order_nsu:payment.order_nsu,transaction_nsu:'SYNTHETIC-TXN-'+payment.id,invoice_slug:'SYNTHETIC-SLUG-'+payment.id,
            receipt_url:'https://recibo.infinitepay.io/SYNTHETIC-TXN-'+payment.id};
        for(let i=0;i<2;i++)if((await f.request('/pagamentos/infinitepay/webhook',{method:'POST',body})).status!==200)denied();
    };
    const dto=async order=>{const out=await f.db('outbox_eventos').where({pedido_id:order.id}).first();return {id:out.id,pedidoId:order.id,tipo:out.tipo,key:out.chave_unica};};
    f.receipt=async order=>f.receiver.lookupReceipt(await dto(order));
    f.recoverDelivery=async order=>{
        if(!f.service.status().running || !await f.authorizer.authorize(f.context('WORKER')) || !await f.authorizer.authorize(f.context('DELIVER_ORDER')))denied();
        const consumer=createDurableOrderConsumer({db:f.db,adapter:f.receiver,now,authorizeSend:()=>f.authorizer.authorize(f.context('DELIVER_ORDER'))});
        return consumer.recover((await dto(order)).key);
    };
    f.health=async()=>{const response=await f.request('/diagnostics');if(response.status!==200)denied();return response.data;};
    f.grantSyntheticReprint=async()=>{
        await f.db('permissoes').insert({nome:'cozinha.reimprimir',descricao:'SYNTHETIC ONLY'}).onConflict('nome').ignore();
        const permission=await f.db('permissoes').where({nome:'cozinha.reimprimir'}).first();
        await f.db('permissoes_usuarios').insert({usuario_id:f.actor.id,permissao_id:permission.id}).onConflict(['usuario_id','permissao_id']).ignore();
    };
    f.reprint=async(order,input)=>{
        await f.authorizer.status({session:f.session});
        if(input.confirmation!=='SIMULAR REIMPRESSAO' || !/^[a-f0-9-]{36}$/.test(input.requestId) ||
            !await f.authorizer.authorize(f.context('DELIVER_ORDER')) || !await f.db('permissoes_usuarios as u').join('permissoes as p','p.id','u.permissao_id')
                .where({'u.usuario_id':f.actor.id,'p.nome':'cozinha.reimprimir'}).first())denied();
        const delivery=await dto(order),receipt=await f.receipt(order);if(!await f.receiver.verifyReceipt(receipt,delivery))denied();
        await f.db('infinitepay_reimpressoes_sinteticas').insert({id:input.requestId,pedido_id:order.id,usuario_id:f.actor.id,recibo:receipt.receiptId,destino:f.destination,criado_em:now()}).onConflict('id').ignore();
        const row=await f.db('infinitepay_reimpressoes_sinteticas').where({id:input.requestId}).first();if(row.pedido_id!==order.id || row.usuario_id!==f.actor.id || row.destino!==f.destination)denied();
        return {id:row.id,printed:false,simulated:true};
    };
    f.close=async()=>{
        if(closed)return;closed=true;
        try{await f.quiesce();}finally{
            try{await f.db.destroy();}finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
        }
    };
    try {
        if(!options.restored) {
            await f.db.migrate.latest();await f.db('infinitepay_identidade_ambiente').where({id:1}).update({identidade:f.env.INFINITEPAY_DATABASE_ID,ambiente:'PRODUCAO'});
            const [role]=await f.db('niveis_acesso').insert({nome:'synthetic-preproduction',descricao:'SYNTHETIC'}).returning('*');
            [f.actor]=await f.db('usuarios').insert({nome:'SYNTHETIC',email:'preproduction@invalid.test',senha_hash:'SYNTHETIC',nivel_acesso_id:role.id}).returning('*');
            const permission=await f.db('permissoes').where({nome:'pagamentos.ativar_producao'}).first();await f.db('permissoes_usuarios').insert({usuario_id:f.actor.id,permissao_id:permission.id});
            const [credential]=await f.db('infinitepay_credenciais').insert({handle:'synthetic-preproduction',...encryptApiKey('SYNTHETIC_PREPROD_KEY','synthetic-preproduction')}).returning('*');
            await f.db('config_infinitepay').where({id:1}).update({handle:credential.handle,credencial_atual_id:credential.id});
            await f.db('metodos_pagamento').insert([['PIX','PIX'],['CARTAO_CREDITO','CREDITO'],['DINHEIRO','DINHEIRO'],['CARTAO_DEBITO','DEBITO']].map(([codigo,tipo_financeiro])=>({nome:'SYNTHETIC '+codigo,codigo,tipo_financeiro})));
            await f.db('tamanhos_marmitas').insert({nome:'SYNTHETIC',preco_base:1});
            await f.db.schema.createTable('infinitepay_destino_sintetico',t=>{t.text('chave_unica').primary();t.string('destino',80).notNullable();t.jsonb('envelope').notNullable();
                t.string('payload_hash',64).notNullable();t.uuid('receipt_id').notNullable().unique();t.timestamp('recebido_em',{useTz:true}).notNullable();t.string('assinatura',64).notNullable();});
            await f.db.schema.createTable('infinitepay_reimpressoes_sinteticas',t=>{t.uuid('id').primary();t.integer('pedido_id').notNullable().references('id').inTable('pedidos');
                t.integer('usuario_id').notNullable().references('id').inTable('usuarios');t.text('recibo').notNullable();t.string('destino',80).notNullable();t.timestamp('criado_em',{useTz:true}).notNullable();});
        }else f.actor=await f.db('usuarios').where({email:'preproduction@invalid.test'}).first();
        f.login();await mount();return f;
    }catch(error){await f.close();throw error;}
}
