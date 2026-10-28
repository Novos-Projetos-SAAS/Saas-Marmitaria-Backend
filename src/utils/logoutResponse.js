// Cookie response shared with the isolated bridge; no session policy or database access here.
export const logout = async (req,res,next) => {
    try {
        const isProduction=process.env.NODE_ENV==='production';
        res.clearCookie('token',{httpOnly:true,secure:isProduction,sameSite:isProduction?'none':'lax'});
        return res.status(200).json({status:'success',message:'Logout realizado com sucesso. Até logo!'});
    }catch(error){next(error);}
};
