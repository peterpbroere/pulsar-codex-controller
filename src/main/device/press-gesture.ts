/** One tap on release, or one hold, even when a timer tick is delayed. */
export class PressGesture {
  private since:number|null=null;
  private held=false;
  constructor(private threshold=700){}
  down(now=Date.now()){if(this.since===null){this.since=now;this.held=false;}}
  tick(now=Date.now()):('hold')[]{
    if(this.since!==null&&!this.held&&now-this.since>=this.threshold){this.held=true;return ['hold'];}
    return [];
  }
  up(now=Date.now()):('tap'|'hold')[]{
    if(this.since===null)return [];
    const events:('tap'|'hold')[]=this.tick(now);
    if(!this.held)events.push('tap');
    this.reset();return events;
  }
  reset(){this.since=null;this.held=false;}
}
