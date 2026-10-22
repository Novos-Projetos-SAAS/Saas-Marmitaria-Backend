import jwt from "jsonwebtoken";

export const verifyToken = (req, res, next) => {
    try {
        const token = req.cookies.token;
        // const token =
        //     req.cookies?.token ||
        //     (req.headers.authorization && req.headers.authorization.split(' ')[1]);


        if (!token) {
            return res.status(401).json({
                status: 'fail',
                message: 'Acesso negado! Faça login para continuar'
            })
        }

        // validando se o token vindo do cookie é igual ao token da chave secret
        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        req.usuario = {
            id: decoded.id,
            nome:decoded.nome,
            cargo: decoded.cargo
        }

        next();
    } catch (error) {

        if (error.name === 'TokenExpiredError') {
            error.message = 'Sua sessão expirou. Por favor, faça login novamente.';
            error.statusCode = 401;
            error.exposeMessage = true;
        } else if (error.name === 'JsonWebTokenError') {
            error.message = 'Token inválido.';
            error.statusCode = 401;
            error.exposeMessage = true;
        }

        if (!error.statusCode) error.statusCode = 401;

        next(error);
    }
}
