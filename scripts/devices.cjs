const HID=require('node-hid');
console.log(JSON.stringify(HID.devices().filter(d=>d.vendorId===0x3710&&d.productId===0x2507),null,2));
