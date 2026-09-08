const express=require('express');
const app=express();

app.use(express.json());

app.get('/health',(req,res)=>{
 res.json({service:'media-service',status:'ok'});
});

app.listen(5000,()=>console.log('Media service running'));
