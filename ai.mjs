import { AI_CONFIG } from './ai-config.mjs';
import { getKey } from './ai-key.mjs';

/** Parse one SSE payload line, returning the text delta (or null). */
function deltaOf(payload) {
  if (!payload || payload === '[DONE]') return null;
  let chunk;
  try { chunk = JSON.parse(payload); } catch { return null; }
  const choice = chunk.choices?.[0];
  if (!choice) return null;
  if (choice.finish_reason === 'length') return { truncated: true };
  const delta = choice.delta?.content;
  return typeof delta === 'string' && delta ? { text: delta } : null;
}

export async function llm(prompt, {signal, system='', json=false, onDelta=null}={}) {
  const controller=new AbortController();
  const cancel=()=>controller.abort(signal?.reason);
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>controller.abort(new DOMException('AI 请求超时，请重试','TimeoutError')),180000);
  const stream=!!onDelta;
  const key=getKey();
  if(!key)throw new Error('还没有填写 API Key。打开「更多功能 → AI 与执行设置」填入硅基流动密钥即可，填一次长期有效。');
  try {
    const response=await fetch(AI_CONFIG.endpoint,{
      method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
      body:JSON.stringify({
        model:AI_CONFIG.model,
        messages:[...(system?[{role:'system',content:system}]:[]),{role:'user',content:prompt}],
        temperature:.2,stream,max_tokens:4096,
        ...(AI_CONFIG.disableThinking?{enable_thinking:false}:{}),
        ...(json?{response_format:{type:'json_object'}}:{})
      }),signal:controller.signal
    });
    if(!response.ok) {
      const data=await response.json().catch(()=>({}));
      const reason=String(data.message || data.error?.message || '').replaceAll(key,'[REDACTED]').slice(0,240);
      throw new Error(`硅基流动请求失败（${response.status}）${reason?`：${reason}`:'，请检查账户权限和模型可用性。'}`);
    }

    let answer='',truncated=false;
    if(stream){
      // Server-sent events: emit every text delta as it arrives so the UI can
      // render the answer while the model is still writing it.
      const emit=payload=>{
        const result=deltaOf(payload);
        if(!result)return;
        if(result.truncated){truncated=true;return;}
        answer+=result.text;onDelta(result.text,answer);
      };
      if(response.body){
        const reader=response.body.getReader(),decoder=new TextDecoder();
        let buffer='';
        for(;;){
          const {done,value}=await reader.read();
          if(done)break;
          buffer+=decoder.decode(value,{stream:true});
          let cut;
          while((cut=buffer.indexOf('\n'))>=0){
            const line=buffer.slice(0,cut).trim();
            buffer=buffer.slice(cut+1);
            if(line.startsWith('data:'))emit(line.slice(5).trim());
          }
        }
        if(buffer.trim().startsWith('data:'))emit(buffer.trim().slice(5).trim());
      }else{
        for(const line of (await response.text()).split('\n'))if(line.trim().startsWith('data:'))emit(line.trim().slice(5).trim());
      }
      if(truncated)throw new Error('模型输出被截断，请缩小问题范围后重试。');
    }else{
      const data=await response.json();
      if(data.choices?.[0]?.finish_reason==='length')throw new Error('模型输出被截断，请缩小问题范围后重试。');
      answer=data.choices?.[0]?.message?.content;
    }

    if(typeof answer!=='string' || !answer.trim())throw new Error('模型未返回有效的文字内容。');
    return answer.replace(/^```[^\n]*\n|```\s*$/g,'');
  } catch(error) {
    if(controller.signal.aborted && !signal?.aborted)throw new Error('AI 请求超过 180 秒，请稍后重试。');
    throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
