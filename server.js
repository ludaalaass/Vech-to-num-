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


// HOME

app.get("/", (req, res) => {

  res.json({
    message: "You are not hacker nigga 😎",
    developer: DEVELOPER
  });

});



// VEHICLE API

app.get("/vehicle", async (req, res) => {

  try {

    const key = req.query.key;

    const vehicle =
      req.query.vehicle ||
      req.query.number;



    if (key !== VALID_KEY) {

      return res.status(403).json({

        developer:DEVELOPER,

        success:false,

        error:
        "Invalid API Key",

        developer_footer:
        DEVELOPER

      });

    }



    if (!vehicle) {

      return res.json({

        developer:DEVELOPER,

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


          timeout:120000

        }
      );



    const result = {

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
        result,
        null,
        2
      )
    );



  } catch(error) {


    res.status(500).json({

      developer:DEVELOPER,

      success:false,

      error:error.message,

      developer_footer:
      DEVELOPER

    });


  }


});



// START

app.listen(PORT,()=>{

 console.log(
   "Running " + PORT
 );

});
