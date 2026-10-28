export type DirectControl = 'key1' | 'key2' | 'key3' | 'press' | 'next' | 'previous';
const PRESS_CONTROLS = new Map<number, DirectControl>([[0,'key1'],[1,'key2'],[2,'key3'],[13,'press']]);

/** XPAD's unsolicited vendor reports, captured on usage page FF11.
 * Encoder pins both emit releases. Only the repeated release pair in the
 * same report denotes a completed detent; counting single releases doubles turns.
 */
export class DirectInput {
  private held = new Set<number>();
  private lastPress = new Map<number, number>();
  reset() { this.held.clear(); this.lastPress.clear(); }
  update(packet: Buffer, now=Date.now()): DirectControl[] {
    if(packet.length<8 || packet[0]!==0x21 || packet[6]!==0xff || packet[7]!==0)return [];
    const length=packet.readUInt16LE(4),end=length+4;
    if(length<6 || end>packet.length || (length&1)!==0)return [];
    let sum=0;for(let i=0;i<end;i+=2)if(i!==2)sum=(sum+packet.readUInt16LE(i))&0xffff;
    if(sum!==packet.readUInt16LE(2))return [];
    const events:DirectControl[]=[];
    for(let i=8;i<end;i+=2){
      const type=packet[i],index=packet[i+1],action=PRESS_CONTROLS.get(index);
      if(action){
        if(type===0x10){
          if(!this.held.has(index) && now-(this.lastPress.get(index)??-Infinity)>=100){
            this.lastPress.set(index,now);events.push(action);
          }
          this.held.add(index);
        }else if(type===0x11)this.held.delete(index);
      }
      if(type===0x11 && (index===14||index===15) && i+3<end && packet[i+2]===0x11 && packet[i+3]===index){
        events.push(index===14?'next':'previous');i+=2;
      }
    }
    return events;
  }
}
