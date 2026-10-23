/*
 * uart-probe.c: a minimal UART chip for the QEMU worker tests
 * (test_board_buses_f6_worker_uart.py).
 *
 *   id  attribute, default 0x11
 *
 * It says nothing on its own. Every byte it hears comes back as two: `id`,
 * then the byte. Two instances with different `id` values tell the test which
 * chip heard a UART, and on which UART it answered.
 */
#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_attr id;
  vx_uart uart;
} probe_t;

static void on_rx(void* ud, uint8_t byte) {
  probe_t* s = (probe_t*)ud;
  uint8_t out[2];
  out[0] = (uint8_t)((int)vx_attr_read(s->id) & 0xff);
  out[1] = byte;
  vx_uart_write(s->uart, out, 2);
}

void chip_setup(void) {
  probe_t* s = (probe_t*)calloc(1, sizeof(probe_t));
  s->id = vx_attr_register("id", 17);

  vx_uart_config cfg = {0};
  cfg.rx = vx_pin_register("RX", VX_INPUT);
  cfg.tx = vx_pin_register("TX", VX_OUTPUT);
  cfg.baud_rate = 9600;
  cfg.on_rx_byte = on_rx;
  cfg.user_data = s;
  s->uart = vx_uart_attach(&cfg);
}
