const express = require('express');
const app = express();

app.use(express.json());

app.get('/health',(req,res)=>{
 res.json({service:'call-service',status:'ok'});
});

app.listen(6000,()=>console.log('Call service running'));
