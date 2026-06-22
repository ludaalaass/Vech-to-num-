const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());


// CONFIG

const BACKEND_API =
"https://vehicleinfo.noobgamingv40.workers.dev/fetch";

const DEVELOPER = "@sahilxalone";

const VALID_KEY = "Demo";


// 7 DAYS EXPIRY

const START_TIME = Date.now();

const EXPIRE_AFTER =
7 * 24 * 60 * 60 * 1000;


// RATE LIMIT

const LIMIT_MIN = 3;
const LIMIT_DAY = 1100;

const users = {};


// RATE CHECK

function checkLimit(key){

 const now = Date.now();


 if(!users[key]){

  users[key]={

   minute:{
    count:0,
    reset:now+60000
   },

   day:{
    count:0,
    reset:now+86400000
   }

  };

 }


 let u = users[key];


 if(now > u.minute.reset){

  u.minute={
   count:0,
   reset:now+60000
  };

 }


 if(now > u.day.reset){

  u.day={
   count:0,
   reset:now+86400000
  };

 }


 if(u.minute.count >= LIMIT_MIN){

  return {
   ok:false,
   msg:"Rate limit: 3 request per minute"
  };

 }


 if(u.day.count >= LIMIT_DAY){

  return {
   ok:false,
   msg:"Daily limit 1100 finished"
  };

 }


 u.minute.count++;
 u.day.count++;


 return {ok:true};

}



// HOME


app.get("/",(req,res)=>{

 res.json({

  message:
  "You are not hacker nigga 😎",

  developer:
  DEVELOPER

 });

});



// VEHICLE


app.get("/vehicle",async(req,res)=>{


try{


 const key=req.query.key;


 const vehicle =
 req.query.vehicle ||
 req.query.number;



 // KEY CHECK


 if(key !== VALID_KEY){


 return res.status(403).json({

  developer:DEVELOPER,

  success:false,

  error:"Invalid API Key",

  developer_footer:
  DEVELOPER

 });


 }



 // EXPIRY CHECK


 if(Date.now()-START_TIME > EXPIRE_AFTER){


 return res.json({

  developer:
  DEVELOPER,

  success:false,

  error:
  "API expired contact @sahilxalone",

  developer_footer:
  DEVELOPER

 });


 }



 // RATE CHECK


 const limit =
 checkLimit(key);


 if(!limit.ok){


 return res.status(429).json({

  developer:
  DEVELOPER,

  success:false,

  error:
  limit.msg,

  developer_footer:
  DEVELOPER

 });


 }




 if(!vehicle){


 return res.json({

  developer:
  DEVELOPER,

  success:false,

  error:
  "Vehicle number required",

  developer_footer:
  DEVELOPER

 });


 }



 const response =
 await axios.get(
 BACKEND_API,
 {

 params:{
  vehicle:vehicle
 },


 headers:{

  "User-Agent":
  "Mozilla/5.0"

 },


 timeout:
 120000


 });




 const final = {


 developer:
 DEVELOPER,


 result:
 response.data,


 developer_footer:
 DEVELOPER


 };



 res.setHeader(
 "Content-Type",
 "application/json"
 );



 res.send(

 JSON.stringify(
 final,
 null,
 2
 )

 );




}catch(e){



 res.status(500).json({


 developer:
 DEVELOPER,


 success:false,


 error:
 e.message,


 developer_footer:
 DEVELOPER


 });


}


});



// START


app.listen(PORT,()=>{

 console.log(
 "Running "+PORT
 );

});
