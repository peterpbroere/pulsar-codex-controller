/** Confirmed by physical + then × holds on 2026-10-28. */
export const AUXILIARY_BUTTONS: ReadonlyMap<number,string> = new Map([[16,'plus'],[17,'minus']]);
/** Active-low KeyStatus edge decoder. A held button produces one press. */
export class ButtonEdges {
  private previous: number | null = null;
  private lastPress = new Map<number, number>();
  constructor(private readonly mapping: ReadonlyMap<number,string>) {}
  reset() { this.previous=null; this.lastPress.clear(); }
  update(releasedMask:number,now=Date.now()):string[] {
    const before=this.previous; this.previous=releasedMask;
    if(before===null)return [];
    const pressed=(before & ~releasedMask)>>>0,events:string[]=[];
    for(const [bit,action] of this.mapping){
      if((pressed & (1<<bit))!==0 && now-(this.lastPress.get(bit)??-Infinity)>=100){
        this.lastPress.set(bit,now);events.push(action);
      }
    }
    return events;
  }
}
