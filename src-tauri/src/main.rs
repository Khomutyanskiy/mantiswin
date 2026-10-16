// Без консольного окна в сборке для пользователя
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mantis_lib::run();
}
