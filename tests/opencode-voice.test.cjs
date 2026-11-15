const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {OpenCodeVoice,validateSpeechConfig,completeSentences}=require('../dist/main/opencode-voice');

const WAV='AAAB///U/w=='; // tiny non-empty base64; servers and hosts are fakes anyway

function stubSpeechServer() {
  const state={stt:[],tts:[]};
  let sttText='run the billing tests please.';
  const server=http.createServer((req,res)=>{
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      if(req.url==='/v1/audio/transcriptions'&&req.method==='POST'){
        state.stt.push({length:Buffer.byteLength(body)});
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({text:sttText}));
      }
      else if(req.url==='/v1/audio/speech'&&req.method==='POST'){
        const parsed=JSON.parse(body);
        state.tts.push(parsed);
        res.writeHead(200,{'content-type':'audio/wav'});
        res.end(Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(240)]));
      }
      else if(req.url==='/api/generate'&&req.method==='POST'){
        const parsed=JSON.parse(body);
        state.generate=state.generate??[];
        state.generate.push(parsed);
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({response:' Updated the invoice flow. All tests passed.'}));
      }
      else{res.writeHead(404);res.end('{}');}
    });
  });
  return {state,setText:t=>{sttText=t;},listen:()=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port))),close:()=>new Promise(r=>{server.closeAllConnections();server.close(r)})};
}
function fakeAudio() {
  const calls=[];
  return {
    calls,
    pttStart:async(id,device)=>{calls.push(['pttStart',id,device]);},
    pttStop:async id=>{calls.push(['pttStop',id]);return WAV;},
    speak:async(id,audio)=>{calls.push(['speak',id,audio]);},
    speakCancel:async id=>{calls.push(['speakCancel',id]);},
    stop:async id=>{calls.push(['stop',id]);},
  };
}
const row={id:'oc:8915:s1',session_id:'s1',label:'Billing agent',state:'idle',reason:'Idle',detail:'',project:'C:\\dev\\app',actions:['continue','focus'],control_token:'ses:s1@8915',review:'',control_hint:'',source:'opencode',opencode:{connected:true,url:'http://127.0.0.1:8915',port:8915,version:'1.19.2'}};

test('speech config validation normalizes URLs and refuses credentials',()=>{
  assert.deepEqual(validateSpeechConfig({ttsUrl:'http://127.0.0.1:8004/',ttsVoice:'Abigail.wav',sttUrl:'http://127.0.0.1:8915'}),
    {ttsUrl:'http://127.0.0.1:8004',ttsVoice:'Abigail.wav',sttUrl:'http://127.0.0.1:8915',ollamaUrl:'http://127.0.0.1:11434',summarizerModel:'gemma4:e2b-it-qat',voiceStyle:'summaries'});
  assert.deepEqual(validateSpeechConfig(undefined),{ttsUrl:'',ttsVoice:'',sttUrl:'',ollamaUrl:'http://127.0.0.1:11434',summarizerModel:'gemma4:e2b-it-qat',voiceStyle:'summaries'});
  assert.equal(validateSpeechConfig({voiceStyle:'full',ollamaUrl:'http://127.0.0.1:11434/',summarizerModel:'gpt-oss:20b'}).voiceStyle,'full');
  assert.throws(()=>validateSpeechConfig({voiceStyle:'loud'}),/voice style/);
  assert.throws(()=>validateSpeechConfig({sttUrl:'ftp://x'}),/HTTP or HTTPS/);
  assert.throws(()=>validateSpeechConfig({sttUrl:'http://user:pw@host'}),/without credentials/);
  assert.throws(()=>validateSpeechConfig({sttUrl:'not a url'}),/complete URL/);
  assert.throws(()=>validateSpeechConfig({ttsVoice:42}),/voice must be a name/);
  assert.throws(()=>validateSpeechConfig({summarizerModel:7}),/summarizer model must be a name/);
});

test('sentence completion respects terminators, quotes, and offsets',()=>{
  // Accumulation model, like message parts: text grows, offset tracks spoken progress.
  let text='Run the tests. Then report! The rest is still';
  let r=completeSentences(text,0);
  assert.deepEqual(r.sentences,['Run the tests.','Then report!']);
  assert.equal(r.offset,'Run the tests. Then report! '.length-1);
  text+=' running.\nNew line "quoted." ok';
  r=completeSentences(text,r.offset);
  assert.deepEqual(r.sentences,['The rest is still running.','New line "quoted."']);
  assert.equal(completeSentences('no terminator yet',0).sentences.length,0);
  assert.deepEqual(completeSentences('',0),{sentences:[],offset:0});
  const elided=completeSentences('Wait... what? Done',0);
  assert.deepEqual(elided.sentences,['Wait...','what?'],'ellipsis counts as a terminator; trailing text waits');
});

test('push-to-talk records, transcribes, sends, and speaks sentences in order',async()=>{
  const stub=stubSpeechServer();
  const port=await stub.listen();
  const audio=fakeAudio();
  const statuses=[];
  const voice=new OpenCodeVoice({audio,changed:s=>statuses.push(s.phase),send:async(rowId,text)=>{stub.state.lastSend=[rowId,text];},now:()=>Date.now()});
  try{
    voice.configure({voiceStyle:'full',ttsUrl:`http://127.0.0.1:${port}`,ttsVoice:'Abigail.wav',sttUrl:`http://127.0.0.1:${port}`},true);
    await voice.toggle(undefined);
    assert.equal(voice.status.phase,'error');
    await voice.toggle(row);
    assert.equal(voice.status.phase,'active');
    assert.equal(voice.status.target.label,'Billing agent');
    await voice.toggle(row); // second tap: stop and send
    assert.equal(voice.status.phase,'active');
    assert.deepEqual(stub.state.lastSend,[row.id,'run the billing tests please.']);
    assert.equal(voice.status.transcript,'run the billing tests please.');
    assert.ok(audio.calls.some(c=>c[0]==='pttStop'),'capture was released');
    assert.equal(voice.targetSessionId,'s1');
    voice.observeText('s1','prt_1','Starting work. Running tests now!');
    await new Promise(r=>setTimeout(r,80));
    const spoken=stub.state.tts;
    assert.deepEqual(spoken.map(t=>t.input),['Starting work.','Running tests now!']);
    assert.deepEqual(spoken.map(t=>t.voice),['Abigail.wav','Abigail.wav']);
    assert.equal(voice.status.reply,'Running tests now!');
    const speakCalls=audio.calls.filter(c=>c[0]==='speak');
    assert.equal(speakCalls.length,2);
    voice.turnUpdate('finished');voice.turnUpdate('finished');
    await new Promise(r=>setTimeout(r,80));
    assert.equal(voice.status.phase,'idle');
    assert.ok(audio.calls.some(c=>c[0]==='stop'),'microphone fully released');
  }finally{voice.close();await stub.close();}
});

test('push-to-talk works without TTS and never speaks when replies are off',async()=>{
  const stub=stubSpeechServer();
  const port=await stub.listen();
  const audio=fakeAudio();
  const voice=new OpenCodeVoice({audio,changed:()=>{},send:async()=>{},now:()=>Date.now()});
  try{
    voice.configure({voiceStyle:'full',ttsUrl:'',ttsVoice:'',sttUrl:`http://127.0.0.1:${port}`},false);
    await voice.toggle(row);
    await voice.toggle(row);
    voice.observeText('s1','prt_1','Two sentences. Would be spoken. But replies are off.');
    await new Promise(r=>setTimeout(r,60));
    assert.equal(stub.state.tts.length,0);
    assert.equal(audio.calls.filter(c=>c[0]==='speak').length,0);
    voice.turnUpdate('finished');voice.turnUpdate('finished');
    await new Promise(r=>setTimeout(r,60));
    assert.equal(voice.status.phase,'idle');
  }finally{voice.close();await stub.close();}
});

test('ending the session or losing the window cancels speech and releases the microphone',async()=>{
  const stub=stubSpeechServer();
  const port=await stub.listen();
  const audio=fakeAudio();
  audio.speak=async(id,audioBase64)=>{audio.calls.push(['speak',id,audioBase64]);await new Promise(r=>setTimeout(r,60));};
  const voice=new OpenCodeVoice({audio,changed:()=>{},send:async()=>{},now:()=>Date.now()});
  try{
    voice.configure({voiceStyle:'full',ttsUrl:`http://127.0.0.1:${port}`,ttsVoice:'',sttUrl:`http://127.0.0.1:${port}`},true);
    await voice.toggle(row);
    await voice.toggle(row);
    voice.observeText('s1','prt_1','Speaking this. And that. And more.');
    await new Promise(r=>setTimeout(r,30));
    const spokenBeforeEnd=stub.state.tts.length;
    assert.ok(spokenBeforeEnd<=1,'at most the first sentence has been synthesized');
    await voice.toggle(row);
    assert.equal(voice.status.phase,'idle');
    await new Promise(r=>setTimeout(r,150));
    assert.equal(stub.state.tts.length,spokenBeforeEnd,'no further synthesis after ending');
    assert.ok(audio.calls.some(c=>c[0]==='speakCancel'),'playback cancelled');
    assert.ok(audio.calls.some(c=>c[0]==='stop'),'capture released');
    await voice.toggle(row);
    await voice.toggle(row);
    voice.turnUpdate('gone');
    await new Promise(r=>setTimeout(r,20));
    assert.equal(voice.status.phase,'error');
    assert.match(voice.status.error,/closed/);
    assert.ok(audio.calls.filter(c=>c[0]==='stop').length>=2);
  }finally{voice.close();await stub.close();}
});

test('summaries style narrates activity briefly and speaks an end-of-turn digest',async()=>{
  const stub=stubSpeechServer();
  const port=await stub.listen();
  const audio=fakeAudio();
  const voice=new OpenCodeVoice({audio,changed:()=>{},send:async()=>{},now:()=>Date.now()});
  try{
    voice.configure({ttsUrl:`http://127.0.0.1:${port}`,ttsVoice:'Abigail.wav',sttUrl:`http://127.0.0.1:${port}`,ollamaUrl:`http://127.0.0.1:${port}`,summarizerModel:'gemma4:e2b-it-qat',voiceStyle:'summaries'},true);
    await voice.toggle(row);
    await voice.toggle(row);
    voice.observeText('s1','prt_1','Starting work. Running tests now! Editing files too.');
    await new Promise(r=>setTimeout(r,60));
    assert.equal(stub.state.tts.length,0,'reply sentences are never spoken in summaries mode');
    voice.announce('s1','tool','bash');
    voice.announce('s1','tool','bash');
    voice.announce('s1','tool','read');
    voice.announce('s1','ask');
    await new Promise(r=>setTimeout(r,120));
    assert.deepEqual(stub.state.tts.map(t=>t.input),
      ['Working in the terminal.','Looking through the files.','Asking your permission.'],
      'narration is brief, categorized, and deduplicated');
    voice.turnUpdate('finished');voice.turnUpdate('finished');
    await new Promise(r=>setTimeout(r,120));
    assert.equal(voice.status.phase,'idle');
    const generate=stub.state.generate?.[0];
    assert.match(generate.prompt,/Starting work\./);
    assert.match(generate.model,/gemma4/);
    assert.deepEqual(stub.state.tts.slice(-1).map(t=>t.input),['Updated the invoice flow. All tests passed.']);
  }finally{voice.close();await stub.close();}
});

test('a permission ask or a poll outage does not end the voice exchange',async()=>{
  const stub=stubSpeechServer();
  const port=await stub.listen();
  const audio=fakeAudio();
  const voice=new OpenCodeVoice({audio,changed:()=>{},send:async()=>{},now:()=>Date.now()});
  try{
    voice.configure({ttsUrl:`http://127.0.0.1:${port}`,ttsVoice:'',sttUrl:`http://127.0.0.1:${port}`,ollamaUrl:`http://127.0.0.1:${port}`,summarizerModel:'gemma4:e2b-it-qat',voiceStyle:'summaries'},true);
    await voice.toggle(row);
    await voice.toggle(row);
    voice.observeText('s1','prt_1','Starting the work.');
    // While waiting for a permission the turn is still running.
    voice.turnUpdate('running');
    await new Promise(r=>setTimeout(r,40));
    assert.equal(voice.status.phase,'active','waiting state ended the exchange');
    // A poll outage is unknown, not finished.
    voice.turnUpdate('unknown');
    await new Promise(r=>setTimeout(r,40));
    assert.equal(voice.status.phase,'active','offline poll ended the exchange');
    // A single finished report is a flap and must not finish either.
    voice.turnUpdate('finished');
    await new Promise(r=>setTimeout(r,40));
    assert.equal(voice.status.phase,'active','single finished report ended the exchange');
    voice.turnUpdate('finished');
    await new Promise(r=>setTimeout(r,120));
    assert.equal(voice.status.phase,'idle');
  }finally{voice.close();await stub.close();}
});

test('summaries fall back to a plain turn-finished line when Ollama is down',async()=>{
  const stub=stubSpeechServer();
  const port=await stub.listen();
  const audio=fakeAudio();
  const voice=new OpenCodeVoice({audio,changed:()=>{},send:async()=>{},now:()=>Date.now()});
  try{
    voice.configure({ttsUrl:`http://127.0.0.1:${port}`,ttsVoice:'',sttUrl:`http://127.0.0.1:${port}`,ollamaUrl:'http://127.0.0.1:9',summarizerModel:'gemma4:e2b-it-qat',voiceStyle:'summaries'},true);
    await voice.toggle(row);
    await voice.toggle(row);
    voice.observeText('s1','prt_1','Did the thing. It worked.');
    voice.turnUpdate('finished');voice.turnUpdate('finished');
    await new Promise(r=>setTimeout(r,150));
    assert.equal(voice.status.phase,'idle');
    assert.deepEqual(stub.state.tts.map(t=>t.input),['Turn finished.']);
  }finally{voice.close();await stub.close();}
});

test('empty transcriptions and failed speech services fail honestly',async()=>{
  const stub=stubSpeechServer();
  const port=await stub.listen();
  stub.setText('   ');
  const audio=fakeAudio();
  const voice=new OpenCodeVoice({audio,changed:()=>{},send:async()=>{},now:()=>Date.now()});
  try{
    voice.configure({voiceStyle:'full',ttsUrl:`http://127.0.0.1:${port}`,ttsVoice:'',sttUrl:`http://127.0.0.1:${port}`},true);
    await voice.toggle(row);
    await voice.toggle(row);
    await new Promise(r=>setTimeout(r,60));
    assert.equal(voice.status.phase,'error');
    assert.match(voice.status.error,/Nothing recognizable/);
    assert.equal(stub.state.tts.length,0);
    stub.setText('One sentence. Two sentence.');
    voice.configure({voiceStyle:'full',ttsUrl:'http://127.0.0.1:9',ttsVoice:'',sttUrl:`http://127.0.0.1:${port}`},true);
    await voice.toggle(row);
    await voice.toggle(row);
    voice.observeText('s1','prt_1','One sentence. Two sentence.');
    await new Promise(r=>setTimeout(r,150));
    assert.match(voice.status.error??'/',/Speech playback failed/);
    assert.equal(voice.status.phase,'active');
    voice.turnUpdate('finished');voice.turnUpdate('finished');
    await new Promise(r=>setTimeout(r,60));
    assert.equal(voice.status.phase,'idle');
  }finally{voice.close();await stub.close();}
});



