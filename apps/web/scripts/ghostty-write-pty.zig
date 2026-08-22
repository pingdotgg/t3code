extern "env" fn t3_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;
extern "env" fn t3_device_attributes(terminal: u32, userdata: u32, out_attrs: u32) bool;

export fn ghostty_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void {
    t3_write_pty(terminal, userdata, data, len);
}

export fn ghostty_device_attributes(terminal: u32, userdata: u32, out_attrs: u32) bool {
    return t3_device_attributes(terminal, userdata, out_attrs);
}
