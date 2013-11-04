var Config = {
  numMaxAnswers: 8,
  mongoDB: 'localhost/colorvote',
  clientID: '192909161969.apps.googleusercontent.com'
};
require('nodetime').profile({
    accountKey: '79ba4e395dcba1c7a1d6e0dfaf2f8a41262dc0b5', 
    appName: 'Node.js Application'
  });

var https = require('https'),
  server = require('http').createServer(handler),
  fs = require('fs'),
  db = require('monk')(Config.mongoDB),
  Questions = db.get('questions'),
  Rooms = db.get('rooms'),
  Votes = db.get('votes'),
  Users = db.get('users');

function handler (req, res) {
  fs.readFile(__dirname + '/index.html',
  function (err, data) {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading index.html');
    }

    res.writeHead(200);
    res.end(data);
  });
}

var Primus = require('primus');
var PrimusRooms = require('primus-rooms');

// primus instance
var primus = new Primus(server, { transformer: 'engine.io' }); //sockjs

// add rooms extension to Primus
primus.use('rooms', PrimusRooms);

/*
primus.on('joinroom', function (room, spark) {
  console.log(spark.id + ' joined ' + room);
});

primus.on('leaveroom', function (room, spark) {
  console.log(spark.id + ' left ' + room);
});
*/

primus.on('connection', function (spark) {
  spark.on('data', function(data) {
    data = data || {};
    var action = data.a;
    
    if('getRooms' === action){
      Rooms.find({}, function(err, docs){
        spark.write({o:'r', v:docs});
      });
    }
    
    if('v' === action){
      var voteNb = data.v,
        userId = data.u,
        questionId = data.q
      
      //TODO: check vote as int 0<max
            
      //insert or update if question is started
      Questions.findById(questionId)
      .success(function(question){
        //get an ObjectId
        questionId = question._id
        if(question.state === 'started'){
          Votes.findOne({q: questionId, u: userId})
          .success(function(vote){
            if (vote) {
              // update existing vote entry
              Votes.update({_id: vote._id}, {$set:{n:voteNb}});
            } else {
              // add new entry
              Votes.insert({q: questionId, u: userId, n: voteNb});
            }

            //TODO: confirm vote to user?
            //spark.write({o:'q', p:'c', v:1});
      
            if(question.modified && new Date().getTime() - question.modified.getTime() > 1500){ //update every x seconds
              Votes.find({q: questionId})
              .success(function(votes){
                var results = createQuestionResult(votes, question.possibleAnswers);
                Questions.update({_id: questionId},
                  {$set:{results:results,
                    votes: votes.length,
                    modified: new Date()
                  }})
                .success(function(){
                  Rooms.findById(question.roomId)
                  .success(function(room){
                    if(room){
                      
                      spark.room(room.name + '-admin').write({o:'q', p:'results', v:results});                
                    }
                  })
                });
              });
            }
          });
        }        
      });
    }
    
    function joinRoomWithQuestion(roomName, question){
      spark.join(roomName, function () {
        if(roomName.split('-').pop() === 'admin'){
          //if admin full question
          question.room = roomName;
          spark.write({o:'q', v: question});
        }else{
          //TODO fix userid
          Votes.findOne({q: question._id, u: data.u})
          .success(function(vote){
            var voteNb = '';
            if(vote && vote.n){
              voteNb = vote.n;
            }
            spark.write({o:'q', v:{
              _id: question._id,
              room: roomName,
              possibleAnswers: question.possibleAnswers,
              state: question.state,
              vote: voteNb
            }});
          })
          .error(function(err){
            console.dir(err);
          })
        }
        updateConnected(roomName);        
      });
    }
    
    if ('join' === action) {
      var roomName = data.v;
      if(typeof roomName === 'string'){
        //TODO: find better solution
        Rooms.findOne({name:  roomName.replace('-admin','')})
        .success(function(room){
          if(room){
            if(room.currentQuestion){
              Questions.findById(room.currentQuestion)
              .success(function(question){
                joinRoomWithQuestion(roomName, question);
              });
            }else{
              createQuestionInRoom(room._id, null, function(question){
                joinRoomWithQuestion(roomName, question);
              });
            }
          }
        });
      }
    }
    
    if ('leave' === action) {
      var room = data.v;
      if(typeof room === 'string'){
        spark.leave(room, function () {
          if(room.split('-').pop() != 'admin'){
            updateConnected(room);
          }
        });
      }
    }
    
    if ('questionAction' === action) {
      validateUser(data.u, data.t, function(){
        getQuestionAndRoom(data.v, function(question, room){
          if(question.state === 'started'){
            //calculate final values
            Votes.find({q: question._id})
            .success(function(votes){                            
              Questions.findAndModify(question._id, {$set: {state: 'stopped',
                dateStopped: new Date(),
                votes: votes.length,
                results: createQuestionResult(votes, question.possibleAnswers),
                modified: new Date()}
              },
              {'new':true})
              .success(function(question){
                //send stopped to clients
                spark.room(room.name).write({o:'q', p:'state', v:'stopped'});
                //send full question to admins
                question.room = room.name + '-admin';
                spark.room(question.room).write({o:'q', v:question});
                //and self
                spark.write({o:'q', v:question});
              });
            });            
          }else if(question.state === 'stopped'){
            createQuestionInRoom( question.roomId, question.possibleAnswers, function(question){
              //send new question to users
              spark.room(room.name).write({o:'q', v:{
                _id: question._id,
                room: room.name,
                possibleAnswers: question.possibleAnswers,
                state: question.state,
                vote: ''
              }});
              //and admins
              question.room = room.name + '-admin';
              spark.room(question.room).write({o:'q', v:question});
              //and self
              spark.write({o:'q', v:question});
            });
          }
        });
      });
    }
    
    function getQuestionAndRoom(questionId, callback){
      Questions.findById(questionId)
      .success(function(question){
        if(question){
          Rooms.findById(question.roomId)
          .success(function(room){
            if(room){
              callback(question, room);
            }
          });
        }
      });
    }
    
    if('possibleAnswers' === action){
      //TODO: validate int 0<max
      validateUser(data.u, data.t, function(){
        getQuestionAndRoom(data.q, function(question, room){
          var possibleAnswers = data.v || Config.numMaxAnswers;
          possibleAnswers = parseInt(possibleAnswers);
          Questions.update({_id: question._id},
            {$set:{possibleAnswers: possibleAnswers}})
          .success(function(){
            var payload = {o:'q', p:'possibleAnswers', v: possibleAnswers}
            spark.room(room.name).write(payload);
            spark.room(room.name + '-admin').write(payload);
          });
        });
      });
    }
    
    if('history' === action){
      Questions.find({roomId: Rooms.id(data.v), state:'stopped'},
      {sort:{dateStopped: -1}, limit:20})
      .success(function(history){
        spark.write({o:'history', v: history});
      });
    }
    
    function validateUser(userId, access_token, success, error){
      Users.findById(userId)
      .success(function(user){
        if(user){
          //TODO should check timeout
          if(user.access_token === access_token){
            success(user);
          }else{
            //validate token
            https.get('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=' + access_token, function(res) {
                var body = '';
                res.on('data', function(chunk) {
                    body += chunk;
                });
                res.on('end', function() {
                    var response = JSON.parse(body);
                    if(response.audience === Config.clientID &&
                      response.user_id === userId){
                      Users.update(userId, {$set:{access_token: access_token}});
                      user.access_token = access_token;
                      success(user)
                    }else{
                      error(response);
                    }
                });
            });
          }
        }else{
          error('user not found');
        }
      });
    }
    
    if('addAdmin' === action){
      validateUser(data.u, data.t, function(){
        Users.insert({_id: data.v, admin: true});
      });
    }
    
    if('login' === action){
      var userId = data.u,
        access_token = data.t;
      validateUser(userId, access_token, function(user){
        spark.write({o:'user', v: user});
      }, function(error){
        spark.write({o:'user', v: {_id: data.u, admin: false}});
      });
    }
    
    function createQuestionInRoom(roomId, possibleAnswers, callback){
      Questions.insert({possibleAnswers: possibleAnswers || Config.numMaxAnswers,
        state:'started',
        dateStarted: new Date(),
        roomId: roomId,
        votes: 0,
        results: createEmptyResult(Config.numMaxAnswers),
        modified: new Date()
      })
      .success(function(question){
        //set as currentQuestion for same room
        Rooms.update(roomId, {$set:{currentQuestion: question._id}})
        .success(function(){
          if(typeof callback === 'function'){
            callback(question);
          }
        });
      });
    };
    
    function createEmptyResult(possibleAnswers){
      return Array.apply(null, new Array(possibleAnswers)).map(Number.prototype.valueOf,0);
    }

    function createQuestionResult(votes, possibleAnswers){
      return votes.reduce(function(memo, voteObj){
        if(voteObj.n < memo.length){
          memo[voteObj.n]++;
        }
        return memo
      }, createEmptyResult(possibleAnswers));
    }
    
    function updateConnected(room){
      primus.room(room).clients(function(empty, ids){
        //TODO timeout?
        spark.room(room + '-admin').write({o:'c', v: ids.length});
      });
    }
  });
});

server.listen(3000);