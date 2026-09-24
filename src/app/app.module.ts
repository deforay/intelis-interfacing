import { DisplayDateTimePipe } from './pipes/display-date-time.pipe';
import { BrowserModule } from '@angular/platform-browser';
import { ErrorHandler, NgModule } from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { CoreModule } from './core/core.module';
import { SharedModule } from './shared/shared.module';

import { AppRoutingModule } from './app-routing.module';

// NG Translate
import { provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { HomeModule } from './home/home.module';

import { AppComponent } from './app.component';
import { SettingsComponent } from './components/settings/settings.component';
import { ConsoleComponent } from './components/console/console.component';
import { RawDataComponent } from './components/raw-data/raw-data.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';

import { DatabaseService } from './services/database.service';
import { TcpConnectionService } from './services/tcp-connection.service';
import { ElectronService } from './core/services';
import { InstrumentInterfaceService } from './services/instrument-interface.service';
import { ElectronStoreService } from './services/electron-store.service';
import { ConnectionManagerService } from './services/connection-manager.service';
import { LogDisplayService } from './services/log-display.service';
import { LoggingService } from './services/logging.service';
import { GlobalErrorHandlerService } from './services/global-error-handler.service';


import { NgxPaginationModule } from 'ngx-pagination';
import { MatPaginatorModule } from '@angular/material/paginator';
import { MatSortModule } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { TransmissionDialogComponent } from './components/transmission-dialog/transmission-dialog.component';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialogModule } from '@angular/material/dialog';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatInputModule } from '@angular/material/input';

@NgModule({
  declarations: [
    AppComponent,
    SettingsComponent,
    ConsoleComponent,
    RawDataComponent,
    DashboardComponent,
    TransmissionDialogComponent,
    DisplayDateTimePipe
  ],
  imports: [
    BrowserModule,
    MatDialogModule,
    MatAutocompleteModule,
    MatInputModule,
    MatCheckboxModule,
    MatTableModule,
    MatSelectModule,
    MatSortModule,
    MatPaginatorModule,
    BrowserAnimationsModule,
    NgxPaginationModule,
    FormsModule,
    HttpClientModule,
    CoreModule,
    SharedModule,
    HomeModule,
    AppRoutingModule,
    ReactiveFormsModule
  ],
  providers: [
    provideTranslateService({
      loader: provideTranslateHttpLoader({ prefix: './assets/i18n/', suffix: '.json' }),
      fallbackLang: 'en'
    }),
    ElectronService,
    DatabaseService,
    TcpConnectionService,
    InstrumentInterfaceService,
    ElectronStoreService,
    ConnectionManagerService,
    { provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'fill' } },
    LogDisplayService,
    LoggingService,
    { provide: ErrorHandler, useClass: GlobalErrorHandlerService }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
